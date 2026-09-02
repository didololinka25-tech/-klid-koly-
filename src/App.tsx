import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  accessRole,
  canManageOperations,
  canViewSchool,
  canWork,
  isTestCleaningDay,
  schoolRepository,
  type AccessRole,
  type AttendanceSettings,
  type AttendanceAuditEntry,
  type AttendanceWorker,
  type AppSettings,
  type BulkCompletionAction,
  type CleaningDayDraft,
  type CleaningDayRecord,
  type ManagedFloor,
  type ManagedRoom,
  type ManualData,
  type ManualEntry,
  type Incident,
  type OperationsData,
  type PlanOptions,
  type Profile,
  type StockItem,
  type UserProfile,
  type WorkerContract,
  type Workplace,
} from "./schoolRepository";
import {
  buildAttendanceReport,
  downloadAttendanceReportPdf,
  reportDuration,
  reportDurationCeil,
  reportMoney,
} from "./attendanceReport";
import { isSupabaseConfigured } from "./supabase";
import { isTaskDueForCleaningDay, monthGridDates, resolveCleaningDay, type CleaningDayContext } from "./scheduling";
import { calculateDpcPaceCard, calculateDppMonthlyBudget } from "./workPace";
import type { ActivityType, Attendance, Frequency, Task } from "./types";
import { attendanceEditorStartValue, pragueDateKey, pragueDateTimeInput } from "./attendanceTime";
import { forBuilding, roomForBuilding } from "./buildingScope";
import { applyBulkUndo, bulkTasks, inferredBulkCompletable, isBulkCompletableTask, orderTasksByDependency } from "./cleaningBulk";
import { createLatestRequestGate } from "./latestRequest";
import {
  isExtraCleaningTask,
  isStandardCleaningTask,
} from "./cleaningPresentation";
import { buildCalendarDaySummary, calendarWorkerOptions, filterCalendarTasks, type CalendarDaySummary } from "./cleaningCalendar";
import { assignmentOverlapsMonth, scheduleExceptionsConflict, workAssignmentsConflict, workerPlanningSaveError, type PlanningWorker, type WorkerPlanningData, type WorkerScheduleException, type WorkerWorkAssignment } from "./workerPlanning";
import { buildTodayWorkBlocks, mandatoryWorkBlockProgress, undoableWorkBlockActions, workBlockIsComplete, type TodayWorkBlock } from "./todayWorkBlocks";

type Section =
  | "Dnes"
  | "Docházka"
  | "Kalendář"
  | "Provoz"
  | "Více"
  | "Manuál"
  | "Rozdělení práce"
  | "Správa"
  | "Uživatelé";
const sections: Section[] = ["Dnes", "Docházka", "Kalendář", "Provoz", "Více"];
const icon: Record<Section, string> = {
  Dnes: "☀",
  Docházka: "◷",
  Kalendář: "▣",
  Provoz: "⚠",
  Více: "•••",
  Manuál: "ⓘ",
  "Rozdělení práce": "♙",
  Správa: "✓",
  Uživatelé: "♙",
};
const frequencies: Frequency[] = [
  "denně",
  "týdně",
  "1–2× týdně",
  "měsíčně",
  "mimořádně",
];
const activityTypes: Record<
  ActivityType,
  { icon: string; label: string }
> = {
  trash: { icon: "🗑", label: "Koš" },
  toilet: { icon: "🚽", label: "WC" },
  sink: { icon: "🚰", label: "Umyvadlo" },
  mirror: { icon: "🪞", label: "Zrcadlo" },
  vacuum: { icon: "🧹", label: "Zamést" },
  mop: { icon: "🧽", label: "Vytřít" },
  tables: { icon: "▤", label: "Stoly" },
  windows: { icon: "▦", label: "Okna" },
  doors: { icon: "▯", label: "Dveře" },
  tiles: { icon: "▦", label: "Obklady" },
  surfaces: { icon: "▤", label: "Povrchy" },
  deep_clean: { icon: "💦", label: "Hloubkově" },
  laundry: { icon: "♨", label: "Praní" },
  other: { icon: "✓", label: "Ostatní" },
};
const weekdays = ["Po", "Út", "St", "Čt", "Pá", "So", "Ne"];
const fourthFloorSlotIndices = [0, 1, 2] as const;
const finalCheckPrefix = "v2026|school|common|final-";
const isFinalCheckTask = (task: Task) => Boolean(task.planKey?.startsWith(finalCheckPrefix) || task.planKey?.startsWith("admin|final|"));
const todayLabel = (dateKey: string) => new Intl.DateTimeFormat("cs-CZ", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "UTC",
}).format(new Date(`${dateKey}T12:00:00Z`));
export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [bulkActions, setBulkActions] = useState<BulkCompletionAction[]>([]);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [cleaningDays, setCleaningDays] = useState<CleaningDayRecord[]>([]);
  const [cleaningDaysAvailable, setCleaningDaysAvailable] = useState(false);
  const [cleaningTaskSelectionAvailable, setCleaningTaskSelectionAvailable] = useState(false);
  const [cleaningDay, setCleaningDay] = useState<CleaningDayContext>({
    kind: isTestCleaningDay ? "preview" : "standard",
    executionDate: localDateKey(),
    scheduleDate: localDateKey(),
    title: isTestCleaningDay ? "Testovací standardní úklid" : "Standardní úklid",
  });
  const [operations, setOperations] = useState<OperationsData>({ stock: [], incidents: [], rooms: [], buildings: [], editable: false, buildingScopeAvailable: false });
  const [manual, setManual] = useState<ManualData>({ entries: [], available: false, editable: false });
  const [attendance, setAttendance] = useState<Attendance[]>([]);
  const [attendanceView, setAttendanceView] = useState<Attendance[]>([]);
  const [attendanceWorkers, setAttendanceWorkers] = useState<AttendanceWorker[]>([]);
  const [selectedAttendanceWorker, setSelectedAttendanceWorker] = useState("");
  const [attendanceSettings, setAttendanceSettings] = useState<AttendanceSettings>({
    plannedShiftsPerWeek: 3,
    configurable: false,
  });
  const [workerContracts, setWorkerContracts] = useState<WorkerContract[]>([]);
  const [appSettings, setAppSettings] = useState<AppSettings>({
    dppAnnualLimitHours: 300,
    dpcWeeklyHoursReference: 20,
    dpcReferencePeriodWeeks: 26,
    dpcMonthlyInsuranceThreshold: 4500,
    available: false,
    contractsAvailable: false,
    compensationAvailable: false,
  });
  const [workplaces, setWorkplaces] = useState<Workplace[]>([]);
  const [workerPlanning, setWorkerPlanning] = useState<WorkerPlanningData>({ assignments: [], exceptions: [], rotationDefinitions: [], rotationSlots: [], available: false });
  const [attendanceBuildingId, setAttendanceBuildingId] = useState("");
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const [attendanceRefresh, setAttendanceRefresh] = useState(0);
  const [attendanceSaving, setAttendanceSaving] = useState(false);
  const attendanceWriteLock = useRef(false);
  const taskWriteLocks = useRef(new Set<string>());
  const [pendingTaskIds, setPendingTaskIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [section, setSection] = useState<Section>("Dnes");
  const [notice, setNotice] = useState("");
  const [planOptions, setPlanOptions] = useState<PlanOptions>({
    buildings: [],
    floors: [],
    rooms: [],
  });
  const [editing, setEditing] = useState<Task | null>(null);
  const [managementView, setManagementView] = useState<"plan" | "rooms">("plan");
  const [todayPlanStatus, setTodayPlanStatus] = useState<"loading" | "refreshing" | "ready" | "error">("loading");
  const [todayPlanError, setTodayPlanError] = useState("");
  const [todayPlanDate, setTodayPlanDate] = useState(() => localDateKey());
  const todayPlanLoaded = useRef(false);
  const todayPlanRequests = useRef(createLatestRequestGate());
  const sessionUserId = useRef<string | null>(null);
  const load = useCallback(
    async (current: Session, knownProfile?: Profile | null) => {
      const planRequestId = todayPlanRequests.current.begin();
      setTodayPlanStatus(todayPlanLoaded.current ? "refreshing" : "loading");
      setTodayPlanError("");
      const activeProfile =
        knownProfile ?? (await schoolRepository.profile(current.user.id));
      if (!activeProfile) {
        if (todayPlanRequests.current.isLatest(planRequestId)) {
          setTodayPlanStatus("error");
          setTodayPlanError("Profil se zatím nepodařilo načíst.");
        }
        setNotice("Profil se zatím nepodařilo načíst.");
        return;
      }
      setProfile(activeProfile);
      if (!activeProfile.active || !canViewSchool(activeProfile)) {
        if (todayPlanRequests.current.isLatest(planRequestId)) {
          setTasks([]);
          setBulkActions([]);
          todayPlanLoaded.current = true;
          setTodayPlanStatus("ready");
        }
        setAttendance([]);
        setAttendanceView([]);
        setAttendanceWorkers([]);
        setUsers([]);
        setWorkplaces([]);
        setWorkerPlanning({ assignments: [], exceptions: [], rotationDefinitions: [], rotationSlots: [], available: false });
        return;
      }
      const [workplacesResult, appSettingsResult] = await Promise.allSettled([
        schoolRepository.workplaces(),
        schoolRepository.appSettings(),
      ]);
      if (workplacesResult.status === "fulfilled") {
        setWorkplaces(workplacesResult.value);
      } else {
        setWorkplaces([]);
      }
      setAppSettings(
        appSettingsResult.status === "fulfilled"
          ? appSettingsResult.value
          : { dppAnnualLimitHours: 300, dpcWeeklyHoursReference: 20, dpcReferencePeriodWeeks: 26, dpcMonthlyInsuranceThreshold: 4500, available: false, contractsAvailable: false, compensationAvailable: false },
      );
      const taskResult = await Promise.resolve(
        schoolRepository.tasks(activeProfile, canManageOperations(activeProfile), localDateKey()),
      ).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason) => ({ status: "rejected" as const, reason }),
      );
      if (taskResult.status === "fulfilled" && todayPlanRequests.current.isLatest(planRequestId)) {
        setTasks(taskResult.value.tasks);
        setBulkActions(taskResult.value.bulkActions);
        setCleaningDay(taskResult.value.cleaningDay);
        setCleaningDaysAvailable(taskResult.value.cleaningDaysAvailable);
        setTodayPlanDate(taskResult.value.dateKey);
        todayPlanLoaded.current = true;
        setTodayPlanStatus("ready");
      } else if (taskResult.status === "rejected" && todayPlanRequests.current.isLatest(planRequestId)) {
        const message = taskResult.reason instanceof Error
          ? taskResult.reason.message
          : "Úkoly se nepodařilo načíst.";
        console.error("Dnešní plán se nepodařilo načíst:", taskResult.reason);
        setTodayPlanStatus("error");
        setTodayPlanError(message);
        setNotice("Nepodařilo se načíst dnešní plán.");
      }
      if (canWork(activeProfile)) {
        const attendanceResult = await schoolRepository.attendance(activeProfile.id);
        setAttendance(attendanceResult);
      } else {
        setAttendance([]);
      }
      if (canManageOperations(activeProfile)) {
        const [optionsResult, workersResult, usersResult] = await Promise.allSettled([
          schoolRepository.planOptions(),
          schoolRepository.attendanceWorkers(),
          activeProfile.is_owner ? schoolRepository.users() : Promise.resolve([]),
        ]);
        if (optionsResult.status === "fulfilled") {
          setPlanOptions(optionsResult.value);
        } else {
          throw optionsResult.reason;
        }
        if (workersResult.status === "fulfilled") {
          setAttendanceWorkers(workersResult.value);
        } else {
          setAttendanceWorkers([
            {
              id: activeProfile.id,
              name: activeProfile.full_name,
              role: accessRole(activeProfile),
            },
          ]);
        }
        setUsers(usersResult.status === "fulfilled" ? usersResult.value : []);
      } else {
        setAttendanceWorkers([
          {
            id: activeProfile.id,
            name: activeProfile.full_name,
            role: accessRole(activeProfile),
          },
        ]);
        setUsers([]);
      }
      const [daysResult, operationsResult, manualResult, planningResult] = await Promise.allSettled([
        schoolRepository.cleaningDays(),
        schoolRepository.operations(),
        schoolRepository.manuals(activeProfile),
        schoolRepository.workerPlanning(),
      ]);
      if (daysResult.status === "fulfilled") {
        setCleaningDays(daysResult.value.records);
        setCleaningDaysAvailable(daysResult.value.available);
        setCleaningTaskSelectionAvailable(daysResult.value.taskSelectionAvailable);
      }
      if (operationsResult.status === "fulfilled") setOperations(operationsResult.value);
      if (manualResult.status === "fulfilled") setManual(manualResult.value);
      if (planningResult.status === "fulfilled") setWorkerPlanning(planningResult.value);
    },
    [],
  );
  useEffect(() => {
    if (!isSupabaseConfigured) return;
    schoolRepository.getSession().then((next) => {
      sessionUserId.current = next?.user.id ?? null;
      setSession(next);
      if (next) load(next).catch((error) => setNotice(error.message));
    });
    const { data } = schoolRepository.onAuthChange((next) => {
      const nextUserId = next?.user.id ?? null;
      const identityChanged = sessionUserId.current !== nextUserId;
      sessionUserId.current = nextUserId;
      setSession(next);
      if (identityChanged) {
        todayPlanRequests.current.invalidate();
        todayPlanLoaded.current = false;
        setTodayPlanStatus("loading");
        setTodayPlanError("");
        setProfile(null);
        setTasks([]);
        setBulkActions([]);
        setUsers([]);
        setCleaningDays([]);
        setCleaningTaskSelectionAvailable(false);
        setAttendance([]);
        setAttendanceView([]);
        setAttendanceWorkers([]);
        setSelectedAttendanceWorker("");
        setWorkplaces([]);
        setManual({ entries: [], available: false, editable: false });
        setWorkerPlanning({ assignments: [], exceptions: [], rotationDefinitions: [], rotationSlots: [], available: false });
        setAttendanceBuildingId("");
      }
      if (next) load(next).catch((error) => setNotice(error.message));
    });
    return () => data.subscription.unsubscribe();
  }, [load]);
  useEffect(() => {
    if (!session || !profile || !canViewSchool(profile)) return;
    const channel = schoolRepository.subscribe(() => {
      setAttendanceRefresh((value) => value + 1);
      load(session, profile).catch((error) => setNotice(error.message));
    });
    return () => {
      channel.unsubscribe();
    };
  }, [session, profile, load]);
  useEffect(() => {
    if (!session || !profile || !canViewSchool(profile)) return;
    const refreshToday = () => {
      if (document.visibilityState === "hidden") return;
      load(session, profile).catch((error) => {
        console.error("Aktualizace po návratu do aplikace selhala:", error);
        setNotice("Nepodařilo se aktualizovat data aplikace.");
      });
    };
    window.addEventListener("focus", refreshToday);
    document.addEventListener("visibilitychange", refreshToday);
    return () => {
      window.removeEventListener("focus", refreshToday);
      document.removeEventListener("visibilitychange", refreshToday);
    };
  }, [session, profile, load]);
  useEffect(() => {
    if (!session || !profile?.is_owner) return;
    const refreshUsers = () => {
      if (document.visibilityState === "hidden") return;
      schoolRepository.users().then(setUsers).catch((error) => setNotice(error.message));
    };
    window.addEventListener("focus", refreshUsers);
    document.addEventListener("visibilitychange", refreshUsers);
    return () => {
      window.removeEventListener("focus", refreshUsers);
      document.removeEventListener("visibilitychange", refreshUsers);
    };
  }, [session, profile]);
  useEffect(() => {
    if (!profile || !canWork(profile)) return;
    const workerId = selectedAttendanceWorker || profile.id;
    if (!selectedAttendanceWorker) setSelectedAttendanceWorker(workerId);
    Promise.all([
      schoolRepository.attendance(workerId),
      schoolRepository.attendanceSettings(workerId),
      schoolRepository.workerContracts(workerId),
    ])
      .then(([records, settings, contracts]) => {
        setAttendanceView(records);
        setAttendanceSettings(settings);
        setWorkerContracts(contracts);
      })
      .catch((error) => setNotice(error.message));
  }, [profile, selectedAttendanceWorker, attendanceRefresh]);
  useEffect(() => {
    const activeWorkplaces = workplaces.filter((item) => item.active);
    if (!activeWorkplaces.some((item) => item.id === attendanceBuildingId)) {
      setAttendanceBuildingId(
        activeWorkplaces.find((item) => item.name === "Škola")?.id ??
          activeWorkplaces[0]?.id ??
          "",
      );
    }
  }, [workplaces, attendanceBuildingId]);
  if (!isSupabaseConfigured) return <SetupScreen />;
  if (!session || !profile)
    return (
      <LoginScreen
        notice={notice}
        onLoginWithGoogle={async () => {
          try {
            setNotice("");
            await schoolRepository.signInWithGoogle();
          } catch (error) {
            setNotice(
              error instanceof Error
                ? error.message
                : "Přihlášení přes Google se nezdařilo.",
            );
          }
        }}
      />
    );
  if (!profile.active)
    return (
      <AccessStateScreen
        title="Účet je deaktivovaný"
        text="Obraťte se na hlavního správce aplikace."
        onSignOut={() => schoolRepository.signOut()}
      />
    );
  if (accessRole(profile) === "pending")
    return (
      <AccessStateScreen
        title="Čeká na schválení"
        text="Hlavní správce zatím vašemu účtu nepřidělil přístup."
        onSignOut={() => schoolRepository.signOut()}
      />
    );
  const complete = async (id: string) => {
    const target = tasks.find((task) => task.id === id);
    if (!target || !target.canComplete || taskWriteLocks.current.has(id)) return;
    if (
      target.prerequisite &&
      !tasks.find((task) => task.id === target.prerequisite)?.done
    ) {
      setNotice("Nejdříve je potřeba zamést nebo vysát.");
      return;
    }
    taskWriteLocks.current.add(id);
    setPendingTaskIds(new Set(taskWriteLocks.current));
    try {
      setNotice("");
      await schoolRepository.setCompletion(id, !target.done);
      setTasks((current) => current.map((task) => task.id === id ? {
        ...task,
        done: !target.done,
        completedBy: !target.done ? profile.full_name : null,
        completedById: !target.done ? profile.id : null,
        completedAt: !target.done ? new Date().toISOString() : null,
      } : task));
      try {
        await load(session, profile);
      } catch {
        setNotice("Úkol je uložený, ale aktuální stav se nepodařilo znovu načíst. Zkontrolujte připojení.");
      }
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Úkol se nepodařilo uložit.",
      );
    } finally {
      taskWriteLocks.current.delete(id);
      setPendingTaskIds(new Set(taskWriteLocks.current));
    }
  };
  const completeMany = async (selectedTasks: Task[]) => {
    const routineTasks = bulkTasks(selectedTasks);
    const orderedTasks = orderTasksByDependency(routineTasks, tasks);
    const selectedIds = orderedTasks.map((task) => task.id);
    if (!selectedIds.length) return;
    if (
      orderedTasks.some((task) => !task.canComplete) ||
      selectedIds.some((id) => taskWriteLocks.current.has(id))
    )
      return;
    selectedIds.forEach((id) => taskWriteLocks.current.add(id));
    setPendingTaskIds(new Set(taskWriteLocks.current));
    try {
      setNotice("");
      await schoolRepository.setCompletions(selectedIds);
      const completedIds = new Set(selectedIds);
      const completedAt = new Date().toISOString();
      setTasks((current) => current.map((task) => completedIds.has(task.id) ? { ...task, done: true, completedBy: profile.full_name, completedById: profile.id, completedAt } : task));
      try {
        await load(session, profile);
      } catch {
        setNotice("Úkoly jsou uložené, ale aktuální stav se nepodařilo znovu načíst. Zkontrolujte připojení.");
      }
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Úkoly místnosti se nepodařilo uložit.",
      );
      throw error;
    } finally {
      selectedIds.forEach((id) => taskWriteLocks.current.delete(id));
      setPendingTaskIds(new Set(taskWriteLocks.current));
    }
  };
  const undoBulkCompletion = async (action: BulkCompletionAction) => {
    if (action.taskIds.some((id) => taskWriteLocks.current.has(id))) return;
    action.taskIds.forEach((id) => taskWriteLocks.current.add(id));
    setPendingTaskIds(new Set(taskWriteLocks.current));
    try {
      setNotice("");
      await schoolRepository.undoBulkCompletion(action.id);
      setTasks((current) => applyBulkUndo(current, action.taskIds));
      setBulkActions((current) => current.filter((item) => item.id !== action.id));
      try {
        await load(session, profile);
      } catch {
        setNotice("Vrácení je uložené, ale aktuální stav se nepodařilo znovu načíst. Zkontrolujte připojení.");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Hromadné dokončení se nepodařilo vrátit.");
      throw error;
    } finally {
      action.taskIds.forEach((id) => taskWriteLocks.current.delete(id));
      setPendingTaskIds(new Set(taskWriteLocks.current));
    }
  };
  const clock = async () => {
    if (attendanceWriteLock.current) return;
    attendanceWriteLock.current = true;
    setAttendanceSaving(true);
    const open = attendance.find((item) => !item.end);
    const previousAttendance = attendance;
    const previousAttendanceView = attendanceView;
    const replaceRecord = (records: Attendance[], record: Attendance) => [
      record,
      ...records.filter((item) => item.id !== record.id),
    ];
    try {
      setNotice("");
      if (open?.id) {
        const optimistic = { ...open, end: new Date().toISOString() };
        setAttendance((records) => replaceRecord(records, optimistic));
        if ((selectedAttendanceWorker || profile.id) === profile.id) {
          setAttendanceView((records) => replaceRecord(records, optimistic));
        }
        const saved = await schoolRepository.finishAttendance(open.id);
        setAttendance((records) => replaceRecord(records, saved));
        if ((selectedAttendanceWorker || profile.id) === profile.id) {
          setAttendanceView((records) => replaceRecord(records, saved));
        }
      } else {
        const startedAt = new Date();
        const optimistic: Attendance = {
          id: `pending-${startedAt.getTime()}`,
          workerId: profile.id,
          buildingId: attendanceBuildingId,
          buildingName:
            workplaces.find((item) => item.id === attendanceBuildingId)?.name ??
            "Škola",
          start: startedAt.toISOString(),
          date: `${startedAt.getFullYear()}-${String(startedAt.getMonth() + 1).padStart(2, "0")}-${String(startedAt.getDate()).padStart(2, "0")}`,
        };
        setAttendance((records) => replaceRecord(records, optimistic));
        if ((selectedAttendanceWorker || profile.id) === profile.id) {
          setAttendanceView((records) => replaceRecord(records, optimistic));
        }
        const saved = await schoolRepository.startAttendance(
          profile.id,
          attendanceBuildingId,
        );
        setAttendance((records) => [
          saved,
          ...records.filter(
            (item) => item.id !== optimistic.id && item.id !== saved.id,
          ),
        ]);
        if ((selectedAttendanceWorker || profile.id) === profile.id) {
          setAttendanceView((records) => [
            saved,
            ...records.filter(
              (item) => item.id !== optimistic.id && item.id !== saved.id,
            ),
          ]);
        }
      }
      setAttendanceRefresh((value) => value + 1);
    } catch (error) {
      setAttendance(previousAttendance);
      setAttendanceView(previousAttendanceView);
      setNotice(
        error instanceof Error
          ? error.message
          : "Docházku se nepodařilo uložit.",
      );
    } finally {
      attendanceWriteLock.current = false;
      setAttendanceSaving(false);
    }
  };
  const saveAttendance = async (
    id: string,
    startedAt: string,
    endedAt?: string,
    buildingId?: string,
  ) => {
    try {
      setNotice("");
      await schoolRepository.updateAttendance(id, startedAt, endedAt, buildingId);
      await load(session, profile);
      setAttendanceRefresh((value) => value + 1);
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Opravu docházky se nepodařilo uložit.",
      );
      throw error;
    }
  };
  const deleteAttendance = async (id: string, workerId: string) => {
    try {
      setNotice("");
      await schoolRepository.deleteAttendance(id, workerId);
      setAttendance((records) => records.filter((item) => item.id !== id));
      setAttendanceView((records) => records.filter((item) => item.id !== id));
      setAttendanceRefresh((value) => value + 1);
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Směnu se nepodařilo smazat.",
      );
      throw error;
    }
  };
  const saveAttendanceSettings = async (value: number) => {
    try {
      setNotice("");
      await schoolRepository.setPlannedShiftsPerWeek(
        selectedAttendanceWorker || profile.id,
        profile.id,
        value,
      );
      setAttendanceRefresh((current) => current + 1);
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Nastavení směn se nepodařilo uložit.",
      );
    }
  };
  const saveOwnProfile = async (fullName: string) => {
    try {
      setNotice("");
      const savedName = await schoolRepository.updateOwnProfileName(fullName);
      setProfile((current) =>
        current ? { ...current, full_name: savedName } : current,
      );
      setAttendanceWorkers((current) =>
        current.map((worker) =>
          worker.id === profile.id ? { ...worker, name: savedName } : worker,
        ),
      );
      setUsers((current) =>
        current.map((user) =>
          user.id === profile.id ? { ...user, fullName: savedName } : user,
        ),
      );
      setTasks((current) =>
        current.map((task) =>
          task.completedById === profile.id
            ? { ...task, completedBy: savedName }
            : task,
        ),
      );
      setBulkActions((current) =>
        current.map((action) =>
          action.workerId === profile.id
            ? { ...action, workerName: savedName }
            : action,
        ),
      );
      setProfileEditorOpen(false);
      setNotice("Profil byl uložen.");
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Profil se nepodařilo uložit.",
      );
      throw error;
    }
  };
  const refreshWorkplaces = async () => {
    setWorkplaces(await schoolRepository.workplaces());
  };
  const saveWorkplace = async (workplace: Workplace) => {
    try {
      setNotice("");
      await schoolRepository.saveWorkplace(workplace);
      await refreshWorkplaces();
      if (canManageOperations(profile)) {
        setPlanOptions(await schoolRepository.planOptions());
      }
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Pracoviště se nepodařilo uložit.",
      );
      throw error;
    }
  };
  const saveDppLimit = async (value: number) => {
    try {
      setNotice("");
      await schoolRepository.saveDppAnnualLimit(value);
      setAppSettings(await schoolRepository.appSettings());
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Roční limit DPP se nepodařilo uložit.",
      );
      throw error;
    }
  };
  const saveWorkerContract = async (contract: WorkerContract) => {
    try {
      setNotice("");
      await schoolRepository.saveWorkerContract(contract);
      setWorkerContracts(await schoolRepository.workerContracts(contract.workerId));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Pracovní vztah se nepodařilo uložit.");
      throw error;
    }
  };
  const saveDpcSettings = async (weeklyHours: number, referenceWeeks: number, monthlyThreshold: number) => {
    try {
      setNotice("");
      await schoolRepository.saveDpcSettings(weeklyHours, referenceWeeks, monthlyThreshold);
      setAppSettings(await schoolRepository.appSettings());
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Nastavení DPČ se nepodařilo uložit.");
      throw error;
    }
  };
  const refreshWorkerPlanning = async () => setWorkerPlanning(await schoolRepository.workerPlanning());
  const saveWorkerAssignment = async (item: WorkerWorkAssignment) => {
    try {
      setNotice("");
      await schoolRepository.saveWorkerWorkAssignment(item);
      await refreshWorkerPlanning();
      setNotice("Pracovní rozdělení bylo uloženo.");
    } catch (error) {
      setNotice(workerPlanningSaveError(error, "Pracovní rozdělení se nepodařilo uložit."));
      throw error;
    }
  };
  const saveScheduleException = async (item: WorkerScheduleException) => {
    try {
      setNotice("");
      await schoolRepository.saveWorkerScheduleException(item);
      await refreshWorkerPlanning();
      setNotice("Výjimka rozvrhu byla uložena.");
    } catch (error) {
      setNotice(workerPlanningSaveError(error, "Výjimku rozvrhu se nepodařilo uložit."));
      throw error;
    }
  };
  const savePlanningWorker = async (worker: PlanningWorker) => {
    try {
      setNotice("");
      await schoolRepository.savePlanningWorker(worker);
      await refreshWorkerPlanning();
      setNotice("Pracovník byl uložen.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Pracovníka se nepodařilo uložit.");
      throw error;
    }
  };
  const saveCleaningRotationSlot = async (slotIndex: number, workerId: string | null, effectiveFrom: string) => {
    try {
      setNotice("");
      await schoolRepository.saveCleaningRotationSlot(slotIndex, workerId, effectiveFrom);
      await refreshWorkerPlanning();
      setNotice("Rotační pozice byla uložena.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Rotační pozici se nepodařilo uložit.");
      throw error;
    }
  };
  const saveTask = async (task: Task) => {
    try {
      setNotice("");
      const savedId = await schoolRepository.saveTask(task);
      const refreshed = await schoolRepository.tasks(profile, true);
      if (!refreshed.tasks.some((item) => item.id === savedId)) {
        throw new Error("Databáze úkol uložila, ale nový plán se nepodařilo ověřit. Obnovte stránku; formulář ponecháváme otevřený, aby se údaje neztratily.");
      }
      setTasks(refreshed.tasks);
      setCleaningDay(refreshed.cleaningDay);
      setCleaningDaysAvailable(refreshed.cleaningDaysAvailable);
      setEditing(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Plán se nepodařilo uložit.";
      setNotice(message);
      throw error;
    }
  };
  const setTaskActive = async (taskId: string, active: boolean) => {
    try {
      setNotice("");
      await schoolRepository.setTaskActive(taskId, active);
      setEditing(null);
      await load(session, profile);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Stav úkolu se nepodařilo změnit.";
      setNotice(message);
      throw error;
    }
  };
  const saveRoom = async (room: ManagedRoom) => {
    try {
      setNotice("");
      await schoolRepository.saveRoom(room);
      await load(session, profile);
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Místnost se nepodařilo uložit.",
      );
      throw error;
    }
  };
  const saveFloor = async (floor: ManagedFloor) => {
    try {
      setNotice("");
      await schoolRepository.saveFloor(floor);
      await load(session, profile);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Patro nebo sekci se nepodařilo uložit.");
      throw error;
    }
  };
  const refreshManual = async () => setManual(await schoolRepository.manuals(profile));
  const saveManualEntry = async (entry: ManualEntry) => {
    try {
      setNotice("");
      await schoolRepository.saveManualEntry(entry, profile.id);
      await refreshManual();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Položku Manuálu se nepodařilo uložit.");
      throw error;
    }
  };
  const setManualEntryActive = async (id: string, active: boolean) => {
    try {
      setNotice("");
      await schoolRepository.setManualEntryActive(id, active, profile.id);
      await refreshManual();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Stav položky Manuálu se nepodařilo změnit.");
      throw error;
    }
  };
  const setRoomActive = async (roomId: string, active: boolean) => {
    try {
      setNotice("");
      await schoolRepository.setRoomActive(roomId, active);
      await load(session, profile);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Stav místnosti se nepodařilo změnit.";
      setNotice(message);
      throw error;
    }
  };
  const saveUserAccess = async (
    userId: string,
    role: AccessRole,
    active: boolean,
  ) => {
    try {
      setNotice("");
      await schoolRepository.updateUserAccess(userId, role, active);
      setUsers(await schoolRepository.users());
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Přístup uživatele se nepodařilo změnit.",
      );
      throw error;
    }
  };
  const refreshCleaningDays = async () => {
    const result = await schoolRepository.cleaningDays();
    setCleaningDays(result.records);
    setCleaningDaysAvailable(result.available);
    setCleaningTaskSelectionAvailable(result.taskSelectionAvailable);
    await load(session, profile);
  };
  const saveCleaningDay = async (draft: CleaningDayDraft) => {
    try {
      setNotice("");
      await schoolRepository.saveCleaningDay(draft);
      await refreshCleaningDays();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Úklidový den se nepodařilo uložit.");
      throw error;
    }
  };
  const cancelCleaningDay = async (id: string) => {
    try {
      setNotice("");
      await schoolRepository.cancelCleaningDay(id);
      await refreshCleaningDays();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Úklidový den se nepodařilo zrušit.");
      throw error;
    }
  };
  const openManagement = (view: "plan" | "rooms") => {
    setManagementView(view);
    setEditing(null);
    setSection("Správa");
  };
  const pendingCount = profile.is_owner
    ? users.filter((user) => user.active && user.role === "pending").length
    : 0;
  const visible = section === "Dnes"
    ? tasks.filter((task) => task.active && task.dueToday)
    : tasks;
  const requiredVisible = visible.filter((task) => task.plannerReason !== "wc-queue");
  const requiredVisibleDone = requiredVisible.filter((task) => task.done).length;
  const optionalQueueRemaining = visible.some((task) => task.plannerReason === "wc-queue" && !task.done);
  const todayExtras = visible.filter((task) => !isFinalCheckTask(task) && isExtraCleaningTask(task));
  const todayExtrasDone = todayExtras.filter((task) => task.done).length;
  const todayBuildingIds = [...new Set(visible.map((task) => task.buildingId).filter((id): id is string => Boolean(id)))];
  const todayContexts = todayBuildingIds.map((buildingId) => resolveCleaningDay(
    todayPlanDate,
    cleaningDays.filter((record) => record.buildingId === buildingId),
    isTestCleaningDay,
  ));
  const displayCleaningDay: CleaningDayContext = todayContexts.length === 1
    ? todayContexts[0]
    : todayContexts.length > 1
      ? { kind: "standard", executionDate: todayPlanDate, scheduleDate: todayPlanDate, title: "Úklid více pracovišť" }
      : cleaningDay;
  const retryTodayPlan = () => load(session, profile).catch((error) => {
    console.error("Opakované načtení dnešního plánu selhalo:", error);
    setNotice("Nepodařilo se načíst dnešní plán.");
  });
  const navigation = sections.filter((item) => {
    if (item === "Docházka") return canWork(profile);
    return true;
  });
  return (
    <main className="app">
      <header>
        <div>
          <p className="eyebrow">ÚKLID ŠKOLY</p>
          <h1>{section}</h1>
          <p className="date">{todayLabel(todayPlanDate)}</p>
        </div>
        <div className="profile-menu-wrap">
          <button
            className="avatar"
            aria-label="Otevřít profil"
            title="Profil"
            aria-expanded={profileMenuOpen}
            onClick={() => setProfileMenuOpen((value) => !value)}
          >
            {profile.full_name[0]}
          </button>
          {profileMenuOpen && (
            <div className="profile-menu">
              <b>{profile.full_name}</b>
              <button
                onClick={() => {
                  setProfileMenuOpen(false);
                  setProfileEditorOpen(true);
                }}
              >
                Upravit profil
              </button>
              <button onClick={() => schoolRepository.signOut()}>Odhlásit se</button>
            </div>
          )}
        </div>
      </header>
      {notice && <div className="notice">{notice}</div>}
      {section === "Dnes" && (
        <>
          {canWork(profile) && (
            <TodayAttendance
              records={attendance}
              onClock={clock}
              saving={attendanceSaving}
              workplaces={workplaces.filter((item) => item.active)}
              buildingId={attendanceBuildingId}
              onBuildingChange={setAttendanceBuildingId}
            />
          )}
          {displayCleaningDay.kind !== "standard" && <section className={`today-day-context ${displayCleaningDay.kind}`}>
            <b>{cleaningDayHeading(displayCleaningDay, visible.length)}</b>
            <small>{cleaningDayDescription(displayCleaningDay)}</small>
          </section>}
          {!todayPlanLoaded.current && todayPlanStatus === "loading" ? (
            <section className="plan-state" aria-live="polite"><span className="loading-spinner" /><h2>Načítám dnešní plán…</h2></section>
          ) : !todayPlanLoaded.current && todayPlanStatus === "error" ? (
            <section className="plan-state error" role="alert"><h2>Nepodařilo se načíst dnešní plán.</h2><p>{todayPlanError}</p><button onClick={retryTodayPlan}>Zkusit znovu</button></section>
          ) : <>
          {todayPlanStatus === "refreshing" && <p className="plan-refreshing" aria-live="polite">Aktualizuji dnešní plán…</p>}
          {todayPlanStatus === "error" && <section className="plan-stale-error" role="alert"><span>Aktualizace plánu se nezdařila. Zobrazuji poslední načtený stav.</span><button onClick={retryTodayPlan}>Zkusit znovu</button></section>}
          {displayCleaningDay.kind !== "preview" && visible.length > 0 && (
            <ArrivalReminders entries={manual.entries.filter((entry) => entry.entryType === "arrival" && entry.active)} />
          )}
          {visible.length > 0 && <TodayExtras tasks={todayExtras} done={todayExtrasDone} onComplete={complete} pendingTaskIds={pendingTaskIds} />}
          {accessRole(profile) === "visitor" && (
            <p className="readonly-note">Návštěvnický přístup je pouze pro čtení.</p>
          )}
          <TaskHierarchy
            tasks={visible}
            bulkActions={bulkActions}
            onComplete={complete}
            onCompleteAll={completeMany}
            onUndoBulk={undoBulkCompletion}
            pendingTaskIds={pendingTaskIds}
            guides={manual.entries.filter((entry) => entry.entryType === "guide" && entry.active)}
          />
          <DepartureChecks
            tasks={visible}
            onComplete={complete}
            pendingTaskIds={pendingTaskIds}
            guides={manual.entries.filter((entry) => entry.entryType === "guide" && entry.active)}
          />
          {requiredVisible.length > 0 && requiredVisibleDone === requiredVisible.length && <p className="today-all-done">{optionalQueueRemaining ? "Povinná práce je hotová – můžete odejít. WC fronta zůstává podle kapacity." : "Všechno hotovo – můžete odejít."}</p>}
          </>}
        </>
      )}
      {section === "Správa" && canManageOperations(profile) && (
        <Management
          tasks={tasks}
          options={planOptions}
          editing={editing}
          onEdit={setEditing}
          onCancel={() => setEditing(null)}
          onSaveTask={saveTask}
          onSetTaskActive={setTaskActive}
          onSaveRoom={saveRoom}
          onSaveFloor={saveFloor}
          onSetRoomActive={setRoomActive}
          view={managementView}
          onView={setManagementView}
        />
      )}
      {section === "Uživatelé" && profile.is_owner && (
        <UserManagement
          users={users}
          currentUserId={profile.id}
          onSave={saveUserAccess}
        />
      )}
      {section === "Docházka" && (
        <AttendanceDashboard
          records={attendanceView}
          workers={attendanceWorkers}
          selectedWorkerId={selectedAttendanceWorker || profile.id}
          onSelectWorker={setSelectedAttendanceWorker}
          settings={attendanceSettings}
          dppAnnualLimitHours={appSettings.dppAnnualLimitHours}
          appSettings={appSettings}
          contracts={workerContracts}
          currentUserId={profile.id}
          isCaretaker={canManageOperations(profile)}
          onClock={clock}
          clockSaving={attendanceSaving}
          workplaces={workplaces.filter((item) => item.active)}
          attendanceBuildingId={attendanceBuildingId}
          onAttendanceBuildingChange={setAttendanceBuildingId}
          ownRecords={attendance}
          onSaveAttendance={saveAttendance}
          onDeleteAttendance={deleteAttendance}
          onSaveSettings={saveAttendanceSettings}
          onSaveContract={saveWorkerContract}
        />
      )}
      {section === "Kalendář" && (
        <CleaningCalendar
          records={cleaningDays}
          available={cleaningDaysAvailable}
          taskSelectionAvailable={cleaningTaskSelectionAvailable}
          canManage={canManageOperations(profile)}
          buildings={workplaces.filter((item) => item.active).map(({ id, name }) => ({ id, name }))}
          tasks={tasks}
          planning={workerPlanning}
          availableWorkers={attendanceWorkers}
          onOpenAssignments={() => setSection("Rozdělení práce")}
          onSave={saveCleaningDay}
          onCancel={cancelCleaningDay}
        />
      )}
      {section === "Rozdělení práce" && (
        <WorkAssignmentOverview data={workerPlanning} profiles={attendanceWorkers} options={planOptions} canManage={canManageOperations(profile)} onSaveWorker={savePlanningWorker} onSaveAssignment={saveWorkerAssignment} onSaveException={saveScheduleException} onSaveRotation={saveCleaningRotationSlot} />
      )}
      {section === "Provoz" && (
        <OperationsScreen
          data={operations}
          userId={profile.id}
          canCreate={canWork(profile)}
          canManage={canManageOperations(profile)}
          onChanged={async () => setOperations(await schoolRepository.operations())}
        />
      )}
      {section === "Manuál" && (
        <ManualScreen
          data={manual}
          tasks={tasks}
          onSave={saveManualEntry}
          onSetActive={setManualEntryActive}
          onEditDeparture={(task) => { setEditing(task); setManagementView("plan"); setSection("Správa"); }}
          onAddDeparture={() => {
            const order = Math.max(930, ...tasks.filter(isFinalCheckTask).map((task) => task.sortOrder)) + 10;
            setEditing({ id: "", planKey: `admin|final|${crypto.randomUUID()}`, room: "Společný úkol", floor: "Společné úkoly", floorSort: -1, building: "Škola", title: "", activityType: "other", frequency: "denně", assignedTo: "Úklidový tým", done: false, canComplete: false, dueToday: false, sortOrder: order, scheduleDays: [1, 3, 5], active: true });
            setManagementView("plan"); setSection("Správa");
          }}
        />
      )}
      {section === "Více" && (
        <MoreScreen
          profile={profile}
          pendingCount={pendingCount}
          onOpenPlan={() => openManagement("plan")}
          onOpenRooms={() => openManagement("rooms")}
          onOpenUsers={async () => {
            setUsers(await schoolRepository.users());
            setSection("Uživatelé");
          }}
          onOpenCleaningDays={() => setSection("Kalendář")}
          onOpenAssignments={() => setSection("Rozdělení práce")}
          onOpenManual={() => setSection("Manuál")}
          workplaces={workplaces}
          appSettings={appSettings}
          onSaveWorkplace={saveWorkplace}
          onSaveDppLimit={saveDppLimit}
          onSaveDpcSettings={saveDpcSettings}
        />
      )}
      {profileEditorOpen && (
        <ProfileEditor
          profile={profile}
          onCancel={() => setProfileEditorOpen(false)}
          onSave={saveOwnProfile}
        />
      )}
      <nav>
        {navigation.map((item) => (
          <button
            key={item}
            className={section === item ? "active" : ""}
            onClick={() => setSection(item)}
          >
            <i>{icon[item]}</i>
            <span>{item}</span>
            {item === "Více" && pendingCount > 0 && (
              <em className="nav-badge" aria-label={`${pendingCount} čeká na schválení`}>
                {pendingCount}
              </em>
            )}
          </button>
        ))}
      </nav>
    </main>
  );
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function localDateKey(date = new Date()) {
  return pragueDateKey(date);
}

function useCurrentTime() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function shiftDuration(record: Attendance, now: Date) {
  return Math.max(
    0,
    (record.end ? new Date(record.end) : now).getTime() -
      new Date(record.start).getTime(),
  );
}

function sumDuration(records: Attendance[], now: Date) {
  return records.reduce((sum, record) => sum + shiftDuration(record, now), 0);
}

function formatDuration(milliseconds: number) {
  const minutes = Math.max(0, Math.round(milliseconds / 60_000));
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

function formatClockDuration(milliseconds: number) {
  const minutes = Math.max(0, Math.round(milliseconds / 60_000));
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("cs-CZ", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function mondayOf(date: Date) {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = result.getDay() || 7;
  result.setDate(result.getDate() - day + 1);
  return result;
}

function attendanceMetrics(
  records: Attendance[],
  now: Date,
  plannedShiftsPerWeek: number,
  annualLimitHours = 300,
) {
  const today = localDateKey(now);
  const year = now.getFullYear();
  const month = today.slice(0, 7);
  const weekStart = mondayOf(now);
  const weekKeys = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(weekStart);
    date.setDate(date.getDate() + index);
    return localDateKey(date);
  });
  const todayMs = sumDuration(
    records.filter((record) => record.date === today),
    now,
  );
  const weekMs = sumDuration(
    records.filter((record) => weekKeys.includes(record.date)),
    now,
  );
  const monthMs = sumDuration(
    records.filter((record) => record.date.startsWith(month)),
    now,
  );
  const yearMs = sumDuration(
    records.filter((record) => record.date.startsWith(`${year}-`)),
    now,
  );
  const yearHours = yearMs / HOUR_MS;
  const remainingHours = Math.max(0, annualLimitHours - yearHours);
  const endOfYear = new Date(year, 11, 31, 23, 59, 59, 999);
  const weeksRemaining = Math.max(
    1,
    Math.ceil((endOfYear.getTime() - now.getTime()) / (7 * DAY_MS)),
  );
  const recommendedWeeklyHours = remainingHours / weeksRemaining;
  const recommendedShiftHours =
    recommendedWeeklyHours / Math.max(1, plannedShiftsPerWeek);
  return {
    today,
    weekKeys,
    todayMs,
    weekMs,
    monthMs,
    yearMs,
    yearHours,
    remainingHours,
    weeksRemaining,
    recommendedWeeklyHours,
    recommendedShiftHours,
  };
}

function ShiftWarnings({ records, now }: { records: Attendance[]; now: Date }) {
  const longest = records.reduce(
    (maximum, record) => Math.max(maximum, shiftDuration(record, now)),
    0,
  );
  return (
    <>
      {longest > 12 * HOUR_MS && (
        <div className="attendance-alert danger">
          Pozor: evidovaná směna přesáhla zákonné maximum 12 hodin.
        </div>
      )}
      {longest > 6 * HOUR_MS && (
        <div className="attendance-alert">
          U směny delší než 6 hodin je potřeba řešit přestávku.
        </div>
      )}
    </>
  );
}

function TodayAttendance({
  records,
  onClock,
  saving,
  workplaces,
  buildingId,
  onBuildingChange,
}: {
  records: Attendance[];
  onClock: () => Promise<void>;
  saving: boolean;
  workplaces: Workplace[];
  buildingId: string;
  onBuildingChange: (id: string) => void;
}) {
  const now = useCurrentTime();
  const todayRecords = records.filter(
    (record) => record.date === localDateKey(now),
  );
  const open = records.find((record) => !record.end);
  const todayMs = sumDuration(todayRecords, now);
  return (
    <section className="today-attendance">
      <div>
        <small>DOCHÁZKA</small>
        {!todayRecords.length && !open && <strong>Směna ještě nezačala</strong>}
        {open && (
          <>
            <span>Aktuální směna: {open.buildingName}</span>
            <span>Příchod: {formatTime(open.start)}</span>
            <strong>Pracuji: {formatDuration(shiftDuration(open, now))}</strong>
          </>
        )}
        {!open && todayRecords.length > 0 && (
          <strong>Dnes odpracováno: {formatDuration(todayMs)}</strong>
        )}
      </div>
      {!open && workplaces.length > 1 && (
        <label className="attendance-workplace">
          Pracoviště této směny
          <select
            value={buildingId}
            onChange={(event) => onBuildingChange(event.target.value)}
            disabled={saving}
          >
            {workplaces.map((workplace) => (
              <option key={workplace.id} value={workplace.id}>
                {workplace.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {(open || workplaces.length > 0) && (
        <button disabled={saving} onClick={() => void onClock()}>
          {saving
            ? "Ukládám…"
            : open
              ? "Odchod"
              : todayRecords.length
                ? "Další příchod"
                : "Příchod"}
        </button>
      )}
      <ShiftWarnings records={todayRecords} now={now} />
    </section>
  );
}

function AttendanceDashboard({
  records,
  workers,
  selectedWorkerId,
  onSelectWorker,
  settings,
  dppAnnualLimitHours,
  appSettings,
  contracts,
  currentUserId,
  isCaretaker,
  onClock,
  clockSaving,
  workplaces,
  attendanceBuildingId,
  onAttendanceBuildingChange,
  ownRecords,
  onSaveAttendance,
  onDeleteAttendance,
  onSaveSettings,
  onSaveContract,
}: {
  records: Attendance[];
  workers: AttendanceWorker[];
  selectedWorkerId: string;
  onSelectWorker: (id: string) => void;
  settings: AttendanceSettings;
  dppAnnualLimitHours: number;
  appSettings: AppSettings;
  contracts: WorkerContract[];
  currentUserId: string;
  isCaretaker: boolean;
  onClock: () => Promise<void>;
  clockSaving: boolean;
  workplaces: Workplace[];
  attendanceBuildingId: string;
  onAttendanceBuildingChange: (id: string) => void;
  ownRecords: Attendance[];
  onSaveAttendance: (
    id: string,
    startedAt: string,
    endedAt?: string,
    buildingId?: string,
  ) => Promise<void>;
  onDeleteAttendance: (id: string, workerId: string) => Promise<void>;
  onSaveSettings: (value: number) => Promise<void>;
  onSaveContract: (contract: WorkerContract) => Promise<void>;
}) {
  const now = useCurrentTime();
  const [editingRecord, setEditingRecord] = useState<Attendance | null>(null);
  const [deletingRecord, setDeletingRecord] = useState<Attendance | null>(null);
  const [plannedShifts, setPlannedShifts] = useState(
    settings.plannedShiftsPerWeek,
  );
  useEffect(
    () => setPlannedShifts(settings.plannedShiftsPerWeek),
    [settings.plannedShiftsPerWeek],
  );
  const metrics = useMemo(
    () =>
      attendanceMetrics(
        records,
        now,
        settings.plannedShiftsPerWeek,
        dppAnnualLimitHours,
      ),
    [records, now, settings.plannedShiftsPerWeek, dppAnnualLimitHours],
  );
  const isOwn = selectedWorkerId === currentUserId;
  const todayKey = pragueDateKey(now);
  const currentContract = contracts.find((contract) => contract.active && contract.validFrom <= todayKey && (!contract.validTo || contract.validTo >= todayKey));
  const isDpp = currentContract?.contractType === "dpp";
  const isDpc = currentContract?.contractType === "dpc";
  const selectedName =
    workers.find((worker) => worker.id === selectedWorkerId)?.name ?? "Pracovník";
  const currentMonthReport = useMemo(() => buildAttendanceReport(
    records,
    selectedName,
    todayKey.slice(0, 7),
    dppAnnualLimitHours,
    now,
    contracts,
    appSettings.dpcMonthlyInsuranceThreshold,
  ), [records, selectedName, todayKey, dppAnnualLimitHours, now, contracts, appSettings.dpcMonthlyInsuranceThreshold]);
  const dppYearHours = currentMonthReport.dppYearMs / HOUR_MS;
  const dppMonthHours = currentMonthReport.dppMonthMs / HOUR_MS;
  const dppRemainingHours = Math.max(0, dppAnnualLimitHours - dppYearHours);
  const dppBudget = currentContract && isDpp ? calculateDppMonthlyBudget({
    month: todayKey.slice(0, 7),
    annualLimitHours: dppAnnualLimitHours,
    dppYearHours,
    dppMonthHours,
    contractValidFrom: currentContract.validFrom,
    contractValidTo: currentContract.validTo,
  }) : undefined;
  const progress = Math.min(
    100,
    (dppYearHours / dppAnnualLimitHours) * 100,
  );
  const yearWarning =
    dppYearHours >= dppAnnualLimitHours
      ? "Roční limit DPP vyčerpán. Evidence dále zaznamenává skutečnou práci."
      : dppYearHours >= dppAnnualLimitHours * (280 / 300)
        ? "Pozor, roční fond DPP je téměř vyčerpán."
        : dppYearHours >= dppAnnualLimitHours * (250 / 300)
          ? `Roční fond DPP se blíží limitu ${dppAnnualLimitHours} hodin.`
          : "";
  return (
    <section className="attendance-dashboard">
      {isCaretaker && (
        <label className="attendance-worker-picker">
          Docházka pracovníka
          <select
            value={selectedWorkerId}
            onChange={(event) => onSelectWorker(event.target.value)}
          >
            {workers.map((worker) => (
              <option key={worker.id} value={worker.id}>
                {worker.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="attendance-owner">
        Zobrazená evidence: <b>{selectedName}</b>
      </p>
      {isOwn && (
        <TodayAttendance
          records={ownRecords}
          onClock={onClock}
          saving={clockSaving}
          workplaces={workplaces}
          buildingId={attendanceBuildingId}
          onBuildingChange={onAttendanceBuildingChange}
        />
      )}
      <div className="attendance-summary-grid">
        <article>
          <small>DNES</small>
          <strong>{formatDuration(metrics.todayMs)}</strong>
        </article>
        <article>
          <small>TENTO TÝDEN</small>
          <strong>{formatDuration(metrics.weekMs)}</strong>
          <span>všechna pracoviště</span>
        </article>
        <article>
          <small>TENTO MĚSÍC</small>
          <strong>{formatDuration(metrics.monthMs)}</strong>
        </article>
        {isDpp ? <article><small>ROK – DPP</small><strong>{dppYearHours.toFixed(1)} / {dppAnnualLimitHours} h</strong><span>Zbývá {dppRemainingHours.toFixed(1)} h</span></article>
          : isDpc ? <article><small>MĚSÍC – DPČ</small><strong>{reportDuration(currentMonthReport.dpcMonthMs)}</strong><span>{currentMonthReport.dpcGrossEstimate === undefined ? "Doplňte hodinovou sazbu" : `${reportMoney(currentMonthReport.dpcGrossEstimate)} z ${reportMoney(appSettings.dpcMonthlyInsuranceThreshold)}`}</span></article>
          : <article><small>PRACOVNÍ VZTAH</small><strong>Není nastaven</strong><span>Správce doplní platnost smlouvy.</span></article>}
      </div>
      {isDpp && yearWarning && (
        <div
          className={`attendance-alert ${dppYearHours >= dppAnnualLimitHours * (280 / 300) ? "danger" : ""}`}
        >
          {yearWarning}
        </div>
      )}
      {isDpp && dppBudget && <section className="pace-card dpp-budget-card">
        <p className="eyebrow">DPP · {todayKey.slice(0, 4)}</p>
        <div className="pace-worked"><strong>{reportDuration(currentMonthReport.dppYearMs)}</strong><span>odpracováno z {dppAnnualLimitHours} h</span></div>
        <div className="dpp-progress" aria-label="Čerpání ročního limitu DPP"><span style={{ width: `${progress}%` }} /></div>
        <div className="pace-metrics">
          <div><span>ZBÝVÁ</span><strong>{formatPlanningHours(dppBudget.annualRemainingHours)}</strong></div>
          <div><span>MĚSÍČNÍ ROZPOČET</span><strong>≈ {formatPlanningHours(dppBudget.monthlyBudgetHours)}</strong><small>zbývá ≈ {formatPlanningHours(dppBudget.monthlyBudgetRemainingHours)}</small></div>
        </div>
        <details className="pace-explanation">
          <summary>ⓘ Jak se to počítá</summary>
          <div>
            <p>Měsíční rozpočet je orientační rovnoměrné rozložení zbývajícího ročního fondu do konce roku nebo aktuálního smluvního období.</p>
            <p>Nejde o zákonné měsíční maximum.</p>
            <div className="shift-setting">
              <label>Směn týdně<input type="number" min="1" max="7" value={plannedShifts} onChange={(event) => setPlannedShifts(Number(event.target.value))} disabled={!settings.configurable} /></label>
              <button onClick={() => void onSaveSettings(plannedShifts)} disabled={!settings.configurable}>Uložit</button>
            </div>
            {!settings.configurable && <small>Nastavení směn zatím nelze měnit.</small>}
          </div>
        </details>
      </section>}
      {isDpc && currentContract && <DpcMonthlySummary report={currentMonthReport} appSettings={appSettings} contract={currentContract} currentDateKey={todayKey} />}
      <ShiftWarnings records={records} now={now} />
      <section className="week-detail">
        <h2>Aktuální týden</h2>
        {metrics.weekKeys.map((date, index) => {
          const value = sumDuration(
            records.filter((record) => record.date === date),
            now,
          );
          return (
            <div key={date}>
              <span>{weekdays[index]}</span>
              <b>{value ? formatClockDuration(value) : "–"}</b>
            </div>
          );
        })}
        <footer>
          <span>
            Celkem tento týden <b>{formatClockDuration(metrics.weekMs)}</b>
          </span>
          {!currentContract && <p>Správce doplní pracovní vztah pro toto období.</p>}
        </footer>
      </section>
      <MonthlyAttendanceReport
        records={records}
        now={now}
        workerName={selectedName}
        appSettings={appSettings}
        contracts={contracts}
      />
      {isCaretaker && <WorkerContractsPanel workerId={selectedWorkerId} contracts={contracts} onSave={onSaveContract} />}
      <AttendanceHistory
        records={records}
        now={now}
        onEdit={setEditingRecord}
        onDelete={setDeletingRecord}
        canViewAudit={isCaretaker}
      />
      {editingRecord && (
        <AttendanceEditor
          record={editingRecord}
          onCancel={() => setEditingRecord(null)}
          workplaces={workplaces}
          onSave={async (start, end, buildingId) => {
            await onSaveAttendance(editingRecord.id, start, end, buildingId);
            setEditingRecord(null);
          }}
        />
      )}
      {deletingRecord && (
        <DeleteAttendanceConfirmation
          record={deletingRecord}
          onCancel={() => setDeletingRecord(null)}
          onConfirm={async () => {
            await onDeleteAttendance(
              deletingRecord.id,
              deletingRecord.workerId,
            );
            setDeletingRecord(null);
          }}
        />
      )}
    </section>
  );
}

function WorkerContractsPanel({ workerId, contracts, onSave }: { workerId: string; contracts: WorkerContract[]; onSave: (contract: WorkerContract) => Promise<void> }) {
  const [editing, setEditing] = useState<WorkerContract | null>(null);
  const [saving, setSaving] = useState(false);
  const label = (value: WorkerContract["contractType"]) => value === "dpp" ? "DPP" : value === "dpc" ? "DPČ" : "Jiný vztah";
  return <section className="worker-contracts panel"><div className="section-heading"><span><p className="eyebrow">PRACOVNÍ VZTAHY</p><h2>Historie smluv</h2></span><button onClick={() => setEditing({ id: "", workerId, contractType: "dpp", validFrom: localDateKey(), validTo: undefined, hourlyRate: undefined, note: "", active: true })}>+ Přidat období</button></div>
    {contracts.map((contract) => <button className="contract-row" key={contract.id} onClick={() => setEditing(contract)}><span><b>{label(contract.contractType)} · {contract.hourlyRate ? `${reportMoney(contract.hourlyRate)}/h` : "sazba chybí"}</b><small>{formatDate(contract.validFrom)} – {contract.validTo ? formatDate(contract.validTo) : "dosud"}{contract.active ? "" : " · neaktivní"}</small></span><i>Upravit</i></button>)}
    {!contracts.length && <p className="hint">Pracovní vztah zatím není nastaven. Datum zahájení se úmyslně nehádá.</p>}
    {editing && <div className="confirmation-backdrop" role="dialog" aria-modal="true"><form className="confirmation-dialog" onSubmit={async (event) => { event.preventDefault(); setSaving(true); try { await onSave(editing); setEditing(null); } finally { setSaving(false); } }}><h2>{editing.id ? "Upravit pracovní vztah" : "Nový pracovní vztah"}</h2>
      <label>Typ<select value={editing.contractType} onChange={(event) => setEditing({ ...editing, contractType: event.target.value as WorkerContract["contractType"] })}><option value="dpp">DPP</option><option value="dpc">DPČ</option><option value="other">Jiný vztah</option></select></label>
      <label>Platí od<input type="date" required value={editing.validFrom} onChange={(event) => setEditing({ ...editing, validFrom: event.target.value })} /></label>
      <label>Platí do<input type="date" value={editing.validTo ?? ""} onChange={(event) => setEditing({ ...editing, validTo: event.target.value || undefined })} /></label>
      <label>Hodinová sazba<div className="money-input"><input type="number" inputMode="decimal" min="0.01" max="100000" step="0.01" required={editing.active} value={editing.hourlyRate ?? ""} onChange={(event) => setEditing({ ...editing, hourlyRate: event.target.value ? Number(event.target.value) : undefined })} /><span>Kč/h</span></div></label>
      <small>Sazba platí jen pro toto období. Při změně sazby vytvořte nové období.</small>
      <label>Poznámka<textarea rows={2} value={editing.note} onChange={(event) => setEditing({ ...editing, note: event.target.value })} /></label>
      <label className="switch"><input type="checkbox" checked={editing.active} onChange={(event) => setEditing({ ...editing, active: event.target.checked })} /> Aktivní</label>
      <div className="editor-actions"><button type="button" onClick={() => setEditing(null)} disabled={saving}>Zrušit</button><button disabled={saving}>{saving ? "Ukládám…" : "Uložit"}</button></div>
    </form></div>}
  </section>;
}

function DpcMonthlySummary({ report, appSettings, contract, currentDateKey }: { report: ReturnType<typeof buildAttendanceReport>; appSettings: AppSettings; contract: WorkerContract; currentDateKey: string }) {
  const progress = report.dpcGrossEstimate === undefined
    ? 0
    : Math.min(100, report.dpcGrossEstimate / appSettings.dpcMonthlyInsuranceThreshold * 100);
  const paceCard = calculateDpcPaceCard({
    month: report.month,
    currentDateKey,
    monthlyThreshold: appSettings.dpcMonthlyInsuranceThreshold,
    grossIncome: report.dpcGrossEstimate ?? 0,
    workedHours: report.dpcMonthMs / HOUR_MS,
    hourlyRate: contract.hourlyRate,
    contractValidFrom: contract.validFrom,
    contractValidTo: contract.validTo,
  });
  const pace = paceCard.pace;
  return <section className="pace-card dpc-month-card">
    <p className="eyebrow">DPČ · {report.monthLabel.toLocaleUpperCase("cs-CZ")}</p>
    <div className="pace-worked"><strong>{reportDuration(report.dpcMonthMs)}</strong><span>odpracováno z {pace.targetHours === undefined ? "—" : formatPlanningHours(pace.targetHours)}</span></div>
    <div className="dpp-progress" aria-label="Postup k měsíčnímu cíli DPČ"><span style={{ width: `${progress}%` }} /></div>
    {report.dpcGrossEstimate === undefined
      ? <p className="attendance-alert">Pro výpočet odměny a potřebného rozsahu doplňte hodinovou sazbu.</p>
      : <>
        <div className="pace-highlight"><span>BĚŽNÉ TEMPO</span><strong>{paceCard.baselineWeeklyText === undefined ? "nelze určit" : `≈ ${paceCard.baselineWeeklyText} týdně`}</strong></div>
        {pace.thresholdReached
          ? <p><b>Nastavená hranice dosažena podle evidované docházky.</b></p>
          : pace.remainingWeeklyHours !== undefined
            ? <div className="pace-current"><span>Aktuálně potřebné tempo</span><strong>≈ {paceCard.remainingWeeklyText} týdně</strong></div>
            : null}
        <div className="pace-metrics">
          <div><span>ZBÝVÁ</span><strong>{paceCard.remainingHoursText ?? "nelze určit"}</strong><small>{reportMoney(pace.remainingIncome)}</small></div>
          <div><span>ODHAD ODMĚNY</span><strong>{reportMoney(report.dpcGrossEstimate)}</strong></div>
        </div>
      </>}
    {contract.hourlyRate && pace.targetHours !== undefined && <details className="pace-explanation">
      <summary>ⓘ Jak se to počítá</summary>
      <div>
        <p>Při sazbě {reportMoney(contract.hourlyRate)}/h je pro nastavenou měsíční hranici {reportMoney(appSettings.dpcMonthlyInsuranceThreshold)} potřeba přibližně {formatPlanningHours(pace.targetHours)} za měsíc.</p>
        <p>Běžné týdenní tempo je orientační rozložení tohoto měsíčního cíle.</p>
        {pace.remainingWeeklyHours === undefined && !pace.thresholdReached && <p>Do konce měsíce už nezbývá celý pracovní týden, proto další týdenní tempo neuvádíme.</p>}
      </div>
    </details>}
  </section>;
}

function formatPlanningHours(hours: number) {
  return reportDurationCeil(hours * HOUR_MS);
}

function MonthlyAttendanceReport({
  records,
  now,
  workerName,
  appSettings,
  contracts,
}: {
  records: Attendance[];
  now: Date;
  workerName: string;
  appSettings: AppSettings;
  contracts: WorkerContract[];
}) {
  const [month, setMonth] = useState(localDateKey(now).slice(0, 7));
  const [preview, setPreview] = useState(false);
  const report = useMemo(
    () =>
      buildAttendanceReport(
        records,
        workerName,
        month,
        appSettings.dppAnnualLimitHours,
        now,
        contracts,
        appSettings.dpcMonthlyInsuranceThreshold,
      ),
    [records, workerName, month, appSettings.dppAnnualLimitHours, appSettings.dpcMonthlyInsuranceThreshold, now, contracts],
  );
  return (
    <section className="monthly-report">
      <div className="section-heading">
        <div><p className="eyebrow">MĚSÍČNÍ VÝKAZ</p><h2>{workerName}</h2></div>
        <input
          type="month"
          value={month}
          onChange={(event) => setMonth(event.target.value)}
          aria-label="Měsíc výkazu"
        />
      </div>
      <div className="monthly-report-summary">
        <span>Celkem za měsíc <b>{reportDuration(report.monthMs)}</b></span>
        <span>Celkem za rok <b>{reportDuration(report.yearMs)}</b></span>
        <span className="report-dpp">{report.contractLabel}{report.dppYearMs > 0 && <b> · DPP rok {reportDuration(report.dppYearMs)} / {appSettings.dppAnnualLimitHours} h</b>}</span>
        <span className="report-dpp">Odhad hrubé odměny <b>{report.grossEstimate === undefined ? "nelze určit" : reportMoney(report.grossEstimate)}</b></span>
      </div>
      <div className="report-actions">
        <button onClick={() => setPreview((value) => !value)}>
          {preview ? "Skrýt náhled" : "Náhled výkazu"}
        </button>
        <button className="primary" onClick={() => downloadAttendanceReportPdf(report)}>
          Stáhnout PDF
        </button>
      </div>
      {preview && <AttendanceReportPreview report={report} />}
    </section>
  );
}

function AttendanceReportPreview({
  report,
}: {
  report: ReturnType<typeof buildAttendanceReport>;
}) {
  return (
    <div className="report-preview">
      <header>
        <small>KLID KOLY</small>
        <h3>VÝKAZ DOCHÁZKY</h3>
        <span>Měsíc: {report.monthLabel}</span>
        <span>Pracovník: {report.workerName}</span>
        <span>Pracoviště: {report.workplaces.join(", ") || "—"}</span>
        <span>Typ: {report.contractLabel}</span>
        <span>Hodinová sazba: {report.hourlyRateLabel}</span>
      </header>
      <div className="report-rows">
        {report.rows.map((row) => (
          <article key={row.id}>
            <b>{new Intl.DateTimeFormat("cs-CZ").format(new Date(`${row.date}T12:00:00`))} · {row.day}</b>
            <span>{row.workplace}</span>
            <span>{row.start}–{row.end}</span>
            <strong>{reportDuration(row.durationMs)}</strong>
          </article>
        ))}
        {!report.rows.length && <p className="hint">V tomto měsíci nejsou evidované směny.</p>}
      </div>
      <footer>
        <b>Celkem za měsíc: {reportDuration(report.monthMs)}</b>
        {report.workplaceTotals.map((total) => (
          <span key={total.name}>{total.name}: {reportDuration(total.durationMs)}</span>
        ))}
        <b>Celkem za rok: {reportDuration(report.yearMs)}</b>
        {report.contractSegments.map((segment) => <span key={segment.key}>{segment.contractType.toUpperCase()} · {formatDate(segment.validFrom)}–{segment.validTo ? formatDate(segment.validTo) : "dosud"} · {segment.hourlyRate ? `${reportMoney(segment.hourlyRate)}/h` : "sazba chybí"} · {reportDuration(segment.durationMs)}</span>)}
        {report.grossEstimate !== undefined ? <b>Odhad hrubé odměny: {reportMoney(report.grossEstimate)}</b> : report.rows.length > 0 && <b>Pro výpočet odměny doplňte pracovní vztah a hodinovou sazbu.</b>}
        {report.dppYearMs > 0 && <b>DPP: {reportDuration(report.dppYearMs)} / {report.annualLimitHours} h</b>}
        {report.dpcMonthMs > 0 && <><span>DPČ · rozhodný příjem podle nastavení: {reportMoney(report.dpcMonthlyThreshold)}</span>{report.dpcThresholdReached ? <b>Nastavená hranice dosažena podle evidované docházky.</b> : report.dpcRemainingIncome !== undefined && <b>Do nastavené hranice zbývá: {reportMoney(report.dpcRemainingIncome)}{report.dpcRemainingMsAtCurrentRate !== undefined ? ` / ${reportDurationCeil(report.dpcRemainingMsAtCurrentRate)}` : ""}</b>}</>}
        <small>Vygenerováno z evidence docházky Klid Koly</small>
      </footer>
    </div>
  );
}

function AttendanceHistory({
  records,
  now,
  onEdit,
  onDelete,
  canViewAudit,
}: {
  records: Attendance[];
  now: Date;
  onEdit: (record: Attendance) => void;
  onDelete: (record: Attendance) => void;
  canViewAudit: boolean;
}) {
  const [auditRecord, setAuditRecord] = useState<Attendance | null>(null);
  const [auditEntries, setAuditEntries] = useState<AttendanceAuditEntry[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditMessage, setAuditMessage] = useState("");
  const openAudit = async (record: Attendance) => {
    setAuditRecord(record);
    setAuditEntries([]);
    setAuditMessage("");
    setAuditLoading(true);
    try {
      const result = await schoolRepository.attendanceAudit(record.id);
      setAuditEntries(result.entries);
      if (!result.available) setAuditMessage("Historie změn bude dostupná po aplikaci migrace 02200.");
      else if (!result.entries.length) setAuditMessage("Tato směna zatím nemá zaznamenanou změnu.");
    } catch (error) {
      setAuditMessage(error instanceof Error ? error.message : "Historii změn se nepodařilo načíst.");
    } finally {
      setAuditLoading(false);
    }
  };
  const months = new Map<string, Attendance[]>();
  records.forEach((record) =>
    months.set(record.date.slice(0, 7), [
      ...(months.get(record.date.slice(0, 7)) ?? []),
      record,
    ]),
  );
  return (
    <section className="attendance-history">
      <h2>Historie směn</h2>
      {[...months.entries()].map(([month, monthRecords], index) => (
        <details key={month} open={index === 0}>
          <summary>
            {new Intl.DateTimeFormat("cs-CZ", {
              month: "long",
              year: "numeric",
            }).format(new Date(`${month}-01T12:00:00`))}
          </summary>
          {monthRecords.map((record) => (
            <article key={record.id}>
              <div>
                <b>
                  {new Intl.DateTimeFormat("cs-CZ").format(
                    new Date(`${record.date}T12:00:00`),
                  )}
                </b>
                <span>
                  {formatTime(record.start)}–{record.end ? formatTime(record.end) : "probíhá"}
                </span>
                <span>{record.buildingName}</span>
                <small>{formatDuration(shiftDuration(record, now))}</small>
              </div>
              <div className="attendance-history-actions">
                <button onClick={() => onEdit(record)}>Opravit</button>
                {canViewAudit && (
                  <button onClick={() => void openAudit(record)}>Historie změn</button>
                )}
                <button className="delete" onClick={() => onDelete(record)}>
                  Smazat
                </button>
              </div>
            </article>
          ))}
        </details>
      ))}
      {!records.length && <p className="hint">Zatím nejsou evidované žádné směny.</p>}
      {auditRecord && (
        <AttendanceAuditDialog
          record={auditRecord}
          entries={auditEntries}
          loading={auditLoading}
          message={auditMessage}
          onClose={() => setAuditRecord(null)}
        />
      )}
    </section>
  );
}

function AttendanceAuditDialog({
  record,
  entries,
  loading,
  message,
  onClose,
}: {
  record: Attendance;
  entries: AttendanceAuditEntry[];
  loading: boolean;
  message: string;
  onClose: () => void;
}) {
  const auditValue = (date: string, start: string, end?: string) =>
    `${new Intl.DateTimeFormat("cs-CZ").format(new Date(`${date}T12:00:00`))} · ${formatTime(start)}–${end ? formatTime(end) : "probíhá"}`;
  return (
    <div className="confirmation-backdrop" role="presentation">
      <section className="confirmation-dialog attendance-audit-dialog" role="dialog" aria-modal="true" aria-labelledby="attendance-audit-title">
        <h2 id="attendance-audit-title">Historie změn směny</h2>
        <p>{new Intl.DateTimeFormat("cs-CZ").format(new Date(`${record.date}T12:00:00`))}</p>
        {loading && <p>Načítám historii…</p>}
        {message && <p className="hint">{message}</p>}
        <div className="attendance-audit-list">
          {entries.map((entry) => (
            <article key={entry.id}>
              <small>{entry.changeKind === "clock_out" ? "Zaznamenání odchodu" : "Ruční oprava"}</small>
              <span><b>Původně:</b> {auditValue(entry.oldDate, entry.oldStart, entry.oldEnd)}</span>
              <span><b>Nově:</b> {auditValue(entry.newDate, entry.newStart, entry.newEnd)}</span>
              <small>{entry.changedByName} · {new Intl.DateTimeFormat("cs-CZ", { dateStyle: "medium", timeStyle: "short" }).format(new Date(entry.changedAt))}</small>
            </article>
          ))}
        </div>
        <div className="confirmation-actions"><button onClick={onClose}>Zavřít</button></div>
      </section>
    </div>
  );
}

function DeleteAttendanceConfirmation({
  record,
  onCancel,
  onConfirm,
}: {
  record: Attendance;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);
  return (
    <div className="confirmation-backdrop" role="presentation">
      <section
        className="confirmation-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-attendance-title"
      >
        <h2 id="delete-attendance-title">
          Opravdu chcete tuto směnu smazat?
        </h2>
        <p>
          {new Intl.DateTimeFormat("cs-CZ").format(
            new Date(`${record.date}T12:00:00`),
          )}{" "}
          · {formatTime(record.start)}–
          {record.end ? formatTime(record.end) : "probíhá"}
        </p>
        <div className="confirmation-actions">
          <button disabled={deleting} onClick={onCancel}>
            Zrušit
          </button>
          <button
            className="danger"
            disabled={deleting}
            onClick={async () => {
              setDeleting(true);
              try {
                await onConfirm();
              } catch {
                // Chybová zpráva se zobrazuje v hlavním upozornění aplikace.
              } finally {
                setDeleting(false);
              }
            }}
          >
            {deleting ? "Mažu…" : "Smazat směnu"}
          </button>
        </div>
      </section>
    </div>
  );
}

function localDateTimeInput(value: string) {
  return pragueDateTimeInput(value);
}

function AttendanceEditor({
  record,
  workplaces,
  onCancel,
  onSave,
}: {
  record: Attendance;
  workplaces: Workplace[];
  onCancel: () => void;
  onSave: (start: string, end?: string, buildingId?: string) => Promise<void>;
}) {
  const [start, setStart] = useState(attendanceEditorStartValue(record.start, record.date));
  const [end, setEnd] = useState(
    record.end ? localDateTimeInput(record.end) : "",
  );
  const [buildingId, setBuildingId] = useState(record.buildingId ?? workplaces[0]?.id ?? "");
  const [saving, setSaving] = useState(false);
  return (
    <form
      className="task-editor attendance-editor"
      onSubmit={async (event) => {
        event.preventDefault();
        if (saving) return;
        setSaving(true);
        try {
          await onSave(start, end || undefined, buildingId || undefined);
        } finally {
          setSaving(false);
        }
      }}
    >
      <h2>Opravit směnu</h2>
      <label>
        Pracoviště
        <select value={buildingId} onChange={(event) => setBuildingId(event.target.value)} required>
          {workplaces.map((workplace) => <option key={workplace.id} value={workplace.id}>{workplace.name}</option>)}
        </select>
      </label>
      <label>
        Příchod
        <input
          type="datetime-local"
          value={start}
          onChange={(event) => setStart(event.target.value)}
          required
        />
      </label>
      <label>
        Odchod
        <input
          type="datetime-local"
          value={end}
          onChange={(event) => setEnd(event.target.value)}
        />
      </label>
      <p className="hint">
        Oprava zachová stejný záznam směny. Historická data se nemažou.
      </p>
      <div className="editor-actions">
        <button type="button" onClick={onCancel} disabled={saving}>
          Zrušit
        </button>
        <button type="submit" disabled={saving}>{saving ? "Ukládám…" : "Uložit opravu"}</button>
      </div>
    </form>
  );
}

function TaskHierarchy({
  tasks,
  bulkActions,
  onComplete,
  onCompleteAll,
  onUndoBulk,
  pendingTaskIds,
  guides,
}: {
  tasks: Task[];
  bulkActions: BulkCompletionAction[];
  onComplete: (id: string) => Promise<void>;
  onCompleteAll: (tasks: Task[]) => Promise<void>;
  onUndoBulk: (action: BulkCompletionAction) => Promise<void>;
  pendingTaskIds: Set<string>;
  guides: ManualEntry[];
}) {
  const workTasks = tasks.filter((task) => !isFinalCheckTask(task));
  const buildings = buildTodayWorkBlocks(workTasks);
  const progress = mandatoryWorkBlockProgress(buildings);
  const commonByBuilding = new Map<string, Task[]>();
  workTasks.filter((task) => !task.roomId && isStandardCleaningTask(task)).forEach((task) => {
    commonByBuilding.set(task.building, [...(commonByBuilding.get(task.building) ?? []), task]);
  });
  return (
    <>
      {progress.total > 0 && <section className="work-block-overview">
        <span><b>Dnešní hlavní práce</b><small>{progress.done} / {progress.total} {progress.total === 1 ? "hlavní část hotová" : progress.total < 5 ? "hlavní části hotové" : "hlavních částí hotovo"}</small></span>
        <ProgressBar value={progress.done} total={progress.total} label="Dokončené hlavní pracovní části" />
      </section>}
      {buildings.map((building) => <section className="building-task-group" key={building.buildingId ?? building.building}>
        {buildings.length > 1 && <h2 className="building-divider">{building.building}</h2>}
        {(commonByBuilding.get(building.building) ?? []).length > 0 && <section className="shared-tasks compact-shared"><p className="eyebrow">PŘED ÚKLIDEM</p><TaskRows tasks={commonByBuilding.get(building.building) ?? []} onComplete={onComplete} pendingTaskIds={pendingTaskIds} guides={guides} /></section>}
        <div className="work-block-list">
          {building.blocks.map((block) => <WorkBlockCard key={block.id} block={block} bulkActions={bulkActions} onComplete={onComplete} onCompleteAll={onCompleteAll} onUndoBulk={onUndoBulk} pendingTaskIds={pendingTaskIds} guides={guides} />)}
          {building.wcQueue && <WcQueueCard block={building.wcQueue} bulkActions={bulkActions} onComplete={onComplete} onCompleteAll={onCompleteAll} onUndoBulk={onUndoBulk} pendingTaskIds={pendingTaskIds} guides={guides} />}
        </div>
      </section>)}
      {workTasks.length === 0 && (
        <section className="empty">
          <span>✓</span>
          <h2>Pro tento den nejsou naplánované úkoly.</h2>
        </section>
      )}
    </>
  );
}
function WorkBlockCard({
  block,
  bulkActions,
  onComplete,
  onCompleteAll,
  onUndoBulk,
  pendingTaskIds,
  guides,
}: {
  block: TodayWorkBlock;
  bulkActions: BulkCompletionAction[];
  onComplete: (id: string) => Promise<void>;
  onCompleteAll: (tasks: Task[]) => Promise<void>;
  onUndoBulk: (action: BulkCompletionAction) => Promise<void>;
  pendingTaskIds: Set<string>;
  guides: ManualEntry[];
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const routine = bulkTasks(block.tasks);
  const done = routine.filter((task) => task.done).length;
  const complete = workBlockIsComplete(block);
  const undoActions = undoableWorkBlockActions(block, bulkActions);
  const latestAction = [...undoActions].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const fallbackCompletion = complete ? routine.find((task) => task.completedBy) : undefined;
  const completedBy = latestAction?.workerName ?? fallbackCompletion?.completedBy;
  const completedAt = latestAction?.createdAt ?? fallbackCompletion?.completedAt;
  const pending = block.tasks.some((task) => pendingTaskIds.has(task.id));
  return (
    <section className={`work-block-card${complete ? " done" : ""}${block.optional ? " optional" : ""}`}>
      <header>
        <h3>{complete && <span aria-hidden="true">✓ </span>}{block.title}</h3>
        <b>{complete ? "Hotovo" : done > 0 ? `${done} / ${routine.length} hotovo` : `${block.rooms.length} ${block.rooms.length === 1 ? "prostor" : block.rooms.length < 5 ? "prostory" : "prostorů"}`}</b>
        {completedBy && <small>{completedBy}{completedAt ? ` · ${new Date(completedAt).toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" })}` : ""}</small>}
      </header>
      <div className="work-block-actions">
        {complete && undoActions.length > 0 ? <button
          className="undo-room"
          disabled={saving}
          onClick={async () => {
            if (!window.confirm("Opravdu chcete vrátit hromadné dokončení této pracovní části?")) return;
            setSaving(true);
            try {
              for (const action of undoActions) await onUndoBulk(action);
            } finally { setSaving(false); }
          }}
        aria-label={`Vrátit dokončení: ${block.title}`}>{saving ? "Vracím…" : "Vrátit dokončení"}</button> : <button
          className="complete-room"
          aria-label={`Označit pracovní část jako hotovou: ${block.title}`}
          disabled={saving || pending || complete || routine.length === 0}
          onClick={async () => {
            setSaving(true);
            try {
              await onCompleteAll(routine);
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? "Ukládám…" : "✓ Hotovo"}
        </button>}
      </div>
      <button className="work-block-detail-toggle" onClick={() => setDetailsOpen((value) => !value)} aria-expanded={detailsOpen}>
        {detailsOpen ? "Skrýt podrobnosti" : "› Podrobnosti"}
      </button>
      {detailsOpen && <div className="work-block-details">
        {block.rooms.map((room) => <section key={room.id}>
          <h4>{room.floor} · {room.name}</h4>
          <TaskRows tasks={room.tasks} onComplete={onComplete} pendingTaskIds={pendingTaskIds} allTasks={block.tasks} guides={guides} compact />
        </section>)}
      </div>}
    </section>
  );
}

function WcQueueCard(props: Omit<Parameters<typeof WorkBlockCard>[0], "block"> & { block: TodayWorkBlock }) {
  const [open, setOpen] = useState(true);
  const floors = new Map<string, Task[]>();
  props.block.tasks.forEach((task) => floors.set(task.floor, [...(floors.get(task.floor) ?? []), task]));
  return <section className="wc-queue-card">
    <button className="wc-queue-heading" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
      <span><h3>WC – otevřená fronta</h3><small>Postupujte od 1. patra nahoru. Udělejte podle času.</small></span>
      <i>{open ? "⌃" : "⌄"}</i>
    </button>
    {open && <div className="wc-queue-floors">
      {[...floors.entries()].sort(([, first], [, second]) => first[0].floorSort - second[0].floorSort).map(([floor, tasks], index) => <WorkBlockCard
        {...props}
        key={floor}
        block={{ ...props.block, id: `${props.block.id}|${floor}`, title: `WC – ${floor}`, tasks, rooms: props.block.rooms.filter((room) => room.floor === floor), sortOrder: index }}
      />)}
    </div>}
  </section>;
}

function DepartureChecks({ tasks, onComplete, pendingTaskIds, guides }: {
  tasks: Task[];
  onComplete: (id: string) => Promise<void>;
  pendingTaskIds: Set<string>;
  guides: ManualEntry[];
}) {
  const finalChecks = tasks.filter(isFinalCheckTask);
  const workTasks = tasks.filter((task) => !isFinalCheckTask(task) && task.plannerReason !== "wc-queue");
  if (!finalChecks.length) return null;
  return <details className="shared-tasks final-checks" open={workTasks.length > 0 && workTasks.every((task) => task.done)}>
    <summary className="section-heading">
      <span><h2>Před odchodem ze školy</h2><small>Povinná společná kontrola</small></span>
      <b>{finalChecks.filter((task) => task.done).length}/{finalChecks.length}</b>
    </summary>
    <TaskRows tasks={finalChecks} onComplete={onComplete} pendingTaskIds={pendingTaskIds} allTasks={tasks} guides={guides} />
  </details>;
}

function TaskRows({
  tasks,
  onComplete,
  pendingTaskIds,
  allTasks = tasks,
  guides = [],
  compact = false,
}: {
  tasks: Task[];
  onComplete: (id: string) => Promise<void>;
  pendingTaskIds: Set<string>;
  allTasks?: Task[];
  guides?: ManualEntry[];
  compact?: boolean;
}) {
  const [openGuide, setOpenGuide] = useState<ManualEntry | null>(null);
  return (
    <div className={`activity-grid${compact ? " compact-task-list" : ""}`}>
      {[...tasks]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((task) => {
          const activity = activityTypes[task.activityType] ?? activityTypes.other;
          const prerequisiteTask = task.prerequisite ? allTasks.find((item) => item.id === task.prerequisite) : undefined;
          const blocked = Boolean(task.prerequisite && !prerequisiteTask?.done);
          const dependencyLabel = prerequisiteTask ? `Nejdřív ${prerequisiteTask.title.toLocaleLowerCase("cs-CZ")}` : "Nejdřív dokončit požadovanou činnost";
          const pending = pendingTaskIds.has(task.id);
          const guide = guides.find((item) => item.activityTypes.includes(task.activityType));
          return (
            <article className={`activity-card${task.done ? " done" : ""}${blocked ? " blocked" : ""}`} key={task.id}>
              <button className="activity-check" disabled={!task.canComplete || pending} onClick={() => void onComplete(task.id)} aria-pressed={task.done} aria-label={`${task.done ? "Zrušit dokončení" : "Dokončit"}: ${task.title}`} title={`${task.title}${task.prerequisite ? " – nejdříve zamést nebo vysát" : ""}`}>
                <span className="activity-icon" aria-hidden="true">{pending ? "…" : task.done ? "✓" : blocked ? "🔒" : activity.icon}</span>
                <span className="activity-copy"><b>{task.title}</b><small>{pending ? "Ukládám…" : blocked ? dependencyLabel : task.done ? "Hotovo" : activity.label}</small></span>
              </button>
              {guide && <button className="task-guide-link" onClick={() => setOpenGuide(guide)}>ⓘ Návod</button>}
            </article>
          );
        })}
      {openGuide && <ManualGuideModal entry={openGuide} onClose={() => setOpenGuide(null)} />}
    </div>
  );
}

function ProgressBar({ value, total, label }: { value: number; total: number; label: string }) {
  const percent = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;
  return <span className="cleaning-progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={value}><i style={{ width: `${percent}%` }} /></span>;
}

function Management({
  tasks,
  options,
  editing,
  onEdit,
  onCancel,
  onSaveTask,
  onSetTaskActive,
  onSaveRoom,
  onSaveFloor,
  onSetRoomActive,
  view,
  onView,
}: {
  tasks: Task[];
  options: PlanOptions;
  editing: Task | null;
  onEdit: (task: Task) => void;
  onCancel: () => void;
  onSaveTask: (task: Task) => Promise<void>;
  onSetTaskActive: (taskId: string, active: boolean) => Promise<void>;
  onSaveRoom: (room: ManagedRoom) => Promise<void>;
  onSaveFloor: (floor: ManagedFloor) => Promise<void>;
  onSetRoomActive: (roomId: string, active: boolean) => Promise<void>;
  view: "plan" | "rooms";
  onView: (view: "plan" | "rooms") => void;
}) {
  const [adminBuildingId, setAdminBuildingId] = useState<string | null>(null);
  const adminBuilding = options.buildings.find((building) => building.id === adminBuildingId);
  if (!adminBuilding) {
    return (
      <section className="panel admin-building-home">
        <p className="eyebrow">PRACOVIŠTĚ</p>
        <h2>Co chcete spravovat?</h2>
        <div className="admin-building-cards">
          {options.buildings.map((building) => (
            <button key={building.id} onClick={() => setAdminBuildingId(building.id)}>
              <b>{building.name}</b>
              <span>{options.rooms.filter((room) => room.buildingId === building.id && room.active).length} místností · {tasks.filter((task) => task.buildingId === building.id && task.active).length} úkolů</span>
            </button>
          ))}
        </div>
      </section>
    );
  }
  const buildingOptions: PlanOptions = {
    buildings: [adminBuilding],
    floors: options.floors.filter((floor) => floor.buildingId === adminBuilding.id),
    rooms: options.rooms.filter((room) => room.buildingId === adminBuilding.id),
  };
  const buildingTasks = tasks.filter((task) => task.buildingId === adminBuilding.id);
  return (
    <>
      <button className="back-button" onClick={() => { onCancel(); setAdminBuildingId(null); }}>← Pracoviště</button>
      <h2>{adminBuilding.name}</h2>
      <div className="management-tabs" role="tablist" aria-label="Správa školy">
        <button
          className={view === "plan" ? "active" : ""}
          onClick={() => onView("plan")}
          role="tab"
          aria-selected={view === "plan"}
        >
          Plán úklidu
        </button>
        <button
          className={view === "rooms" ? "active" : ""}
          onClick={() => onView("rooms")}
          role="tab"
          aria-selected={view === "rooms"}
        >
          Místnosti
        </button>
      </div>
      {view === "plan" ? (
        <PlanManager
          tasks={buildingTasks}
          options={buildingOptions}
          buildingId={adminBuilding.id}
          editing={editing}
          onEdit={onEdit}
          onCancel={onCancel}
          onSave={onSaveTask}
          onSetActive={onSetTaskActive}
        />
      ) : (
        <RoomManager buildingId={adminBuilding.id} options={buildingOptions} tasks={buildingTasks} onSave={onSaveRoom} onSaveFloor={onSaveFloor} onSetActive={onSetRoomActive} />
      )}
    </>
  );
}

function PlanManager({
  tasks,
  options,
  buildingId,
  editing,
  onEdit,
  onCancel,
  onSave,
  onSetActive,
}: {
  tasks: Task[];
  options: PlanOptions;
  buildingId: string;
  editing: Task | null;
  onEdit: (task: Task) => void;
  onCancel: () => void;
  onSave: (task: Task) => Promise<void>;
  onSetActive: (taskId: string, active: boolean) => Promise<void>;
}) {
  const selectedBuilding = options.buildings.find((building) => building.id === buildingId);
  const addTask = (room?: PlanOptions["rooms"][number]) =>
    onEdit({
      id: "",
      roomId: room?.id,
      room: room?.name ?? "Společný úkol",
      floor: room?.floor ?? "Společné úkoly",
      floorSort: room?.floorSort ?? -1,
      building: room?.building ?? "Škola",
      title: "",
      activityType: "other",
      frequency: "denně",
      assignedTo: "nepřiřazeno",
      done: false,
      dueToday: false,
      sortOrder: 10,
      scheduleDays: [1, 3, 5],
      monthlyDay: null,
      periodMonths: undefined,
      periodWeek: undefined,
      periodAnchorMonth: undefined,
      bulkCompletable: Boolean(room),
      active: true,
    });
  const floors = options.floors.filter((floor) => floor.buildingId === buildingId).sort((a, b) => a.sortOrder - b.sortOrder);
  const commonTasks = tasks.filter((task) => !task.roomId && task.active && task.buildingId === buildingId);
  const inactiveTasks = tasks.filter((task) => !task.active && task.buildingId === buildingId);
  return (
    <section className="plan-manager">
      <p className="hint">
        Správce může přidat nebo upravit plán. Deaktivovaný úkol zůstane v
        historii, ale nezobrazí se pracovníkům.
      </p>
      {editing ? (
        <TaskEditor
          task={editing}
          tasks={tasks}
          options={options}
          onCancel={onCancel}
          onSave={onSave}
          onSetActive={onSetActive}
        />
      ) : (
        <>
          <div className="admin-tree">
            {floors.map((floor) => {
              const rooms = options.rooms
                .filter((room) => room.floorId === floor.id && room.active)
                .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "cs"));
              const floorTaskCount = rooms.reduce(
                (sum, room) => sum + tasks.filter((task) => task.roomId === room.id && task.active).length,
                0,
              );
              return (
                <details key={floor.id} className="admin-floor">
                  <summary><b>{options.buildings.find((building) => building.id === floor.buildingId)?.name ?? "Pracoviště"} · {floor.name}</b><span>{floorTaskCount} úkolů</span></summary>
                  {rooms.map((room) => {
                    const roomTasks = tasks
                      .filter((task) => task.roomId === room.id && task.active)
                      .sort((a, b) => a.sortOrder - b.sortOrder);
                    return (
                      <details key={room.id} className="admin-room">
                        <summary>
                          <span><b>{room.name}</b>{!room.active && <small>neaktivní</small>}</span>
                          <span>{roomTasks.filter((task) => task.active).length}</span>
                        </summary>
                        <div className="admin-actions-list">
                          {roomTasks.map((task) => (
                            <button key={task.id} className="plan-row" onClick={() => onEdit({ ...task })}>
                              <span><b>{task.title}</b><small>{formatTaskSchedule(task)}{task.prerequisite ? " · po předchozí činnosti" : ""}</small></span>
                              <i>Upravit</i>
                            </button>
                          ))}
                          <button className="add-task compact" onClick={() => addTask(room)}>+ Přidat činnost</button>
                        </div>
                      </details>
                    );
                  })}
                </details>
              );
            })}
            <details className="admin-floor">
              <summary><b>Společné úkoly</b><span>{commonTasks.length} úkolů</span></summary>
              <div className="admin-actions-list">
                {commonTasks.sort((a, b) => a.sortOrder - b.sortOrder).map((task) => (
                  <button key={task.id} className="plan-row" onClick={() => onEdit({ ...task })}>
                    <span><b>{task.title}</b><small>{formatTaskSchedule(task)}</small></span><i>Upravit</i>
                  </button>
                ))}
                {selectedBuilding?.name === "Škola" && <button className="add-task compact" onClick={() => addTask()}>+ Přidat společný úkol</button>}
              </div>
            </details>
            {inactiveTasks.length > 0 && (
              <details className="admin-floor inactive-section">
                <summary><b>Neaktivní / smazané</b><span>{inactiveTasks.length} úkolů</span></summary>
                <div className="admin-actions-list">
                  {inactiveTasks
                    .sort((a, b) => a.floorSort - b.floorSort || a.sortOrder - b.sortOrder)
                    .map((task) => (
                      <button key={task.id} className="plan-row inactive" onClick={() => onEdit({ ...task })}>
                        <span><b>{task.title}</b><small>{task.floor} · {task.room} · Neaktivní</small></span>
                        <i>Obnovit</i>
                      </button>
                    ))}
                </div>
              </details>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function RoomManager({
  buildingId,
  options,
  tasks,
  onSave,
  onSaveFloor,
  onSetActive,
}: {
  buildingId: string;
  options: PlanOptions;
  tasks: Task[];
  onSave: (room: ManagedRoom) => Promise<void>;
  onSaveFloor: (floor: ManagedFloor) => Promise<void>;
  onSetActive: (roomId: string, active: boolean) => Promise<void>;
}) {
  const selectedBuilding = options.buildings.find((building) => building.id === buildingId);
  const buildingFloors = options.floors
    .filter((floor) => !selectedBuilding || floor.buildingId === selectedBuilding.id)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const [editingRoom, setEditingRoom] = useState<ManagedRoom | null>(null);
  const [editingFloor, setEditingFloor] = useState<ManagedFloor | null>(null);
  const inactiveRooms = options.rooms.filter((room) => !room.active && (!selectedBuilding || room.buildingId === selectedBuilding.id));
  const addRoom = (floorId: string) => {
    const floor = buildingFloors.find((item) => item.id === floorId);
    if (!floor || !selectedBuilding) return;
    const floorRooms = options.rooms.filter((room) => room.floorId === floor.id);
    setEditingRoom({
      id: "",
      buildingId: selectedBuilding.id,
      floorId: floor.id,
      name: "",
      active: true,
      sortOrder: Math.max(0, ...floorRooms.map((room) => room.sortOrder)) + 10,
    });
  };
  const save = async (room: ManagedRoom) => {
    await onSave(room);
    setEditingRoom(null);
  };
  const setActive = async (roomId: string, active: boolean) => {
    try {
      await onSetActive(roomId, active);
      setEditingRoom(null);
    } catch {
      // Hlavní obrazovka zobrazí bezpečnou serverovou chybu a editor zůstane otevřený.
    }
  };
  return (
    <section className="room-manager">
      {editingFloor ? (
        <form className="task-editor room-editor" onSubmit={async (event) => { event.preventDefault(); await onSaveFloor(editingFloor); setEditingFloor(null); }}>
          <h2>{editingFloor.id ? "Upravit patro / sekci" : "Nové patro / sekce"}</h2>
          <label>Název<input required value={editingFloor.name} onChange={(event) => setEditingFloor({ ...editingFloor, name: event.target.value })} /></label>
          <label>Pořadí<input type="number" value={editingFloor.sortOrder} onChange={(event) => setEditingFloor({ ...editingFloor, sortOrder: Number(event.target.value) })} /></label>
          <div className="editor-actions"><button type="button" onClick={() => setEditingFloor(null)}>Zrušit</button><button>Uložit</button></div>
        </form>
      ) : editingRoom ? (
        <RoomEditor
          room={editingRoom}
          options={options}
          onCancel={() => setEditingRoom(null)}
          onSave={save}
          onSetActive={setActive}
        />
      ) : (
        <>
          {selectedBuilding && <button className="add-task" onClick={() => setEditingFloor({ id: "", buildingId: selectedBuilding.id, name: "", sortOrder: Math.max(0, ...buildingFloors.map((floor) => floor.sortOrder)) + 10 })}>+ Přidat patro / sekci</button>}
          <div className="admin-tree">
            {buildingFloors.map((floor) => {
              const rooms = options.rooms.filter((room) => room.floorId === floor.id && room.active)
                .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "cs"));
              return (
                <details key={floor.id} className="admin-floor">
                  <summary><b>{floor.name}</b><span>{rooms.length} místností</span></summary>
                  <div className="room-admin-list">
                    <button className="room-admin-row floor-edit" onClick={() => setEditingFloor(floor)}><span><b>Upravit patro / sekci</b><small>Název a pořadí</small></span><i>Upravit</i></button>
                    {rooms.map((room) => (
                      <button key={room.id} className={room.active ? "room-admin-row" : "room-admin-row inactive"} onClick={() => setEditingRoom({ id: room.id, buildingId: room.buildingId, floorId: room.floorId, name: room.name, active: room.active, sortOrder: room.sortOrder })}>
                        <span><b>{room.name}</b><small>{tasks.filter((task) => task.roomId === room.id && task.active).length} aktivních činností · pořadí {room.sortOrder}{room.active ? "" : " · neaktivní"}</small></span>
                        <i>Upravit</i>
                      </button>
                    ))}
                    <button className="add-task compact" onClick={() => addRoom(floor.id)}>+ Přidat místnost</button>
                  </div>
                </details>
              );
            })}
            {inactiveRooms.length > 0 && (
              <details className="admin-floor inactive-section">
                <summary><b>Neaktivní / smazané</b><span>{inactiveRooms.length} místností</span></summary>
                <div className="room-admin-list">
                  {inactiveRooms
                    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "cs"))
                    .map((room) => (
                      <button key={room.id} className="room-admin-row inactive" onClick={() => setEditingRoom({ ...room })}>
                        <span><b>{room.name}</b><small>Neaktivní · úkoly zůstávají vypnuté</small></span>
                        <i>Obnovit</i>
                      </button>
                    ))}
                </div>
              </details>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function RoomEditor({
  room,
  options,
  onCancel,
  onSave,
  onSetActive,
}: {
  room: ManagedRoom;
  options: PlanOptions;
  onCancel: () => void;
  onSave: (room: ManagedRoom) => Promise<void>;
  onSetActive: (roomId: string, active: boolean) => Promise<void>;
}) {
  const [draft, setDraft] = useState(room);
  const floors = options.floors
    .filter((floor) => floor.buildingId === draft.buildingId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const setFloor = (floorId: string) => {
    const floor = options.floors.find((item) => item.id === floorId);
    setDraft((current) => ({
      ...current,
      floorId: floorId || null,
      buildingId: floor?.buildingId ?? current.buildingId,
    }));
  };
  return (
    <form
      className="task-editor room-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(draft);
      }}
    >
      <h2>{room.id ? "Upravit místnost" : "Nová místnost"}</h2>
      <label>
        Budova
        <select
          value={draft.buildingId}
          onChange={(event) => {
            const firstFloor = options.floors.find(
              (floor) => floor.buildingId === event.target.value,
            );
            setDraft((current) => ({
              ...current,
              buildingId: event.target.value,
              floorId: firstFloor?.id ?? null,
            }));
          }}
        >
          {options.buildings.map((building) => (
            <option key={building.id} value={building.id}>
              {building.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Patro / sekce
        <select
          value={draft.floorId ?? ""}
          onChange={(event) => setFloor(event.target.value)}
          required
        >
          <option value="">Vyberte patro nebo sekci</option>
          {floors.map((floor) => (
            <option key={floor.id} value={floor.id}>
              {floor.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Název místnosti
        <input
          value={draft.name}
          onChange={(event) =>
            setDraft((current) => ({ ...current, name: event.target.value }))
          }
          required
        />
      </label>
      <label>
        Pořadí
        <input
          type="number"
          value={draft.sortOrder}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              sortOrder: Number(event.target.value),
            }))
          }
        />
      </label>
      {!draft.active && <p className="inactive-badge">Neaktivní místnost</p>}
      <div className="editor-actions">
        <button type="button" onClick={onCancel}>
          Zrušit
        </button>
        <button type="submit">Uložit místnost</button>
      </div>
      {room.id && room.active && (
        <div className="danger-zone">
          <button
            type="button"
            className="danger-action"
            onClick={() => {
              if (window.confirm("Smazáním místnosti se z aktivního plánu odstraní také všechny její úkoly. Historie zůstane zachovaná.\n\nOpravdu chcete místnost smazat?")) {
                void onSetActive(room.id, false);
              }
            }}
          >
            Smazat místnost
          </button>
        </div>
      )}
      {room.id && !room.active && (
        <div className="restore-zone">
          <p>Obnoví se pouze místnost. Její úkoly zůstanou neaktivní, dokud je jednotlivě neobnovíte.</p>
          <button type="button" onClick={() => void onSetActive(room.id, true)}>Obnovit místnost</button>
        </div>
      )}
    </form>
  );
}

function TaskEditor({
  task,
  tasks,
  options,
  onCancel,
  onSave,
  onSetActive,
}: {
  task: Task;
  tasks: Task[];
  options: PlanOptions;
  onCancel: () => void;
  onSave: (task: Task) => Promise<void>;
  onSetActive: (taskId: string, active: boolean) => Promise<void>;
}) {
  const [draft, setDraft] = useState(task);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const saveLock = useRef(false);
  const departureCheck = isFinalCheckTask(draft);
  const update = <K extends keyof Task>(key: K, value: Task[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const setRoom = (id: string) => {
    const room = options.rooms.find((item) => item.id === id);
    setDraft((current) => ({
      ...current,
      roomId: id || undefined,
      room: room?.name ?? "Společný úkol",
      floor: room?.floor ?? "Společné úkoly",
      floorSort: room?.floorSort ?? -1,
      building: room?.building ?? "Škola",
      prerequisite: undefined,
    }));
  };
  const toggleDay = (day: number) =>
    update(
      "scheduleDays",
      draft.scheduleDays.includes(day)
        ? draft.scheduleDays.filter((item) => item !== day)
        : [...draft.scheduleDays, day].sort(),
    );
  return (
    <form
      className="task-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (saveLock.current) return;
        saveLock.current = true;
        setSaving(true);
        setSaveError("");
        void onSave(draft)
          .catch((error) => setSaveError(error instanceof Error ? error.message : "Plán se nepodařilo uložit."))
          .finally(() => {
            saveLock.current = false;
            setSaving(false);
          });
      }}
    >
      <h2>{task.id ? "Upravit úkol" : "Nový úkol"}</h2>
      {saveError && <div className="notice" role="alert">{saveError}</div>}
      <label>
        Činnost
        <input
          value={draft.title}
          onChange={(event) => update("title", event.target.value)}
          required
        />
      </label>
      <label>
        Typ činnosti / ikona
        <select
          value={draft.activityType}
          onChange={(event) =>
            update("activityType", event.target.value as ActivityType)
          }
        >
          {(Object.entries(activityTypes) as [ActivityType, { icon: string; label: string }][]).map(
            ([value, activity]) => (
              <option value={value} key={value}>
                {activity.icon} {activity.label}
              </option>
            ),
          )}
        </select>
      </label>
      {departureCheck && <p className="hint">Tato společná kontrola se automaticky zobrazuje před odchodem při každém skutečném úklidovém dni.</p>}
      {!departureCheck && <label>
        Místnost / společný úkol
        <select
          value={draft.roomId ?? ""}
          onChange={(event) => setRoom(event.target.value)}
        >
          <option value="">Společný úkol</option>
          {options.rooms.filter((room) => room.active || room.id === draft.roomId).map((room) => (
            <option key={room.id} value={room.id}>
              {room.building} · {room.floor} · {room.name}
            </option>
          ))}
        </select>
      </label>}
      {!departureCheck && <label>
        Patro / sekce
        <input value={draft.floor} readOnly />
      </label>}
      {!departureCheck && <label>
        Frekvence
        <select
          value={draft.frequency}
          onChange={(event) =>
            update("frequency", event.target.value as Frequency)
          }
        >
          {frequencies.map((item) => (
            <option key={item}>{item}</option>
          ))}
        </select>
      </label>}
      {!departureCheck && draft.frequency !== "měsíčně" && draft.frequency !== "mimořádně" && (
        <fieldset>
          <legend>Dny v týdnu</legend>
          <div className="day-buttons">
            {weekdays.map((day, index) => (
              <button
                type="button"
                className={
                  draft.scheduleDays.includes(index + 1) ? "selected" : ""
                }
                onClick={() => toggleDay(index + 1)}
                key={day}
              >
                {day}
              </button>
            ))}
          </div>
        </fieldset>
      )}
      {!departureCheck && draft.frequency === "měsíčně" && (
        <>
          <label>
            Způsob rozložení
            <select
              value={draft.periodMonths ? "period" : "day"}
              onChange={(event) => {
                if (event.target.value === "period") {
                  update("periodMonths", 1);
                  update("periodWeek", 2);
                  update("periodAnchorMonth", `${localDateKey().slice(0, 7)}-01`);
                  update("monthlyDay", null);
                } else {
                  update("periodMonths", null);
                  update("periodWeek", null);
                  update("periodAnchorMonth", null);
                  update("monthlyDay", 1);
                }
              }}
            >
              <option value="period">V určeném týdnu období</option>
              <option value="day">Pevný den v měsíci (legacy)</option>
            </select>
          </label>
          {draft.periodMonths ? (
            <div className="period-fields">
              <label>Opakovat každých
                <select value={draft.periodMonths} onChange={(event) => update("periodMonths", Number(event.target.value))}>
                  <option value={1}>1 měsíc</option><option value={2}>2 měsíce</option><option value={3}>3 měsíce</option>
                </select>
              </label>
              <label>Týden období
                <select value={draft.periodWeek ?? 2} onChange={(event) => update("periodWeek", Number(event.target.value))}>
                  <option value={1}>1. týden</option><option value={2}>2. týden</option><option value={3}>3. týden</option><option value={4}>4. týden</option>
                </select>
              </label>
            </div>
          ) : (
            <label>Den v měsíci
              <input type="number" min="1" max="31" value={draft.monthlyDay ?? 1} onChange={(event) => update("monthlyDay", Number(event.target.value))} />
            </label>
          )}
        </>
      )}
      {!departureCheck && <label>
        Předchozí nutná činnost
        <select
          value={draft.prerequisite ?? ""}
          onChange={(event) => update("prerequisite", event.target.value || undefined)}
        >
          <option value="">Bez závislosti</option>
          {tasks
            .filter((item) => item.id !== draft.id && item.roomId === draft.roomId && item.active)
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((item) => (
              <option key={item.id} value={item.id}>{item.title}</option>
            ))}
        </select>
        <small>Například vytření až po zametení nebo vysátí.</small>
      </label>}
      {!departureCheck && draft.roomId && <label className="bulk-setting">
        <input
          type="checkbox"
          checked={isBulkCompletableTask(draft)}
          disabled={!inferredBulkCompletable(draft)}
          onChange={(event) => update("bulkCompletable", event.target.checked)}
        />
        <span>
          Zahrnout do rychlého dokončení místnosti
          <small>Vypněte u práce, kterou je nutné potvrdit samostatně. Okna, hloubkové čištění, praní, měsíční a mimořádné úkoly jsou vždy samostatné.</small>
        </span>
      </label>}
      <label>
        Pořadí
        <input
          type="number"
          value={draft.sortOrder}
          onChange={(event) => update("sortOrder", Number(event.target.value))}
        />
      </label>
      {!draft.active && <p className="inactive-badge">Neaktivní úkol</p>}
      <div className="editor-actions">
        <button type="button" onClick={onCancel}>
          Zrušit
        </button>
        <button type="submit" disabled={saving}>{saving ? "Ukládám…" : "Uložit plán"}</button>
      </div>
      {task.id && task.active && (
        <div className="danger-zone">
          <p>Historie dokončení zůstane zachovaná. Pokud na úkol navazuje jiná aktivní činnost, smazání bude bezpečně zamítnuto.</p>
          <button
            type="button"
            className="danger-action"
            onClick={() => {
              if (window.confirm("Opravdu chcete tento úkol smazat? Historie dokončení zůstane zachovaná.")) {
                void onSetActive(task.id, false).catch(() => undefined);
              }
            }}
          >
            Smazat úkol
          </button>
        </div>
      )}
      {task.id && !task.active && (
        <div className="restore-zone">
          <button type="button" onClick={() => void onSetActive(task.id, true).catch(() => undefined)}>Obnovit úkol</button>
        </div>
      )}
    </form>
  );
}

const roleLabel = (role: AccessRole) =>
  ({
    pending: "čeká na schválení",
    cleaning_team: "úklidový tým",
    admin: "správce",
    visitor: "návštěvník",
  })[role];

function UserManagement({
  users,
  currentUserId,
  onSave,
}: {
  users: UserProfile[];
  currentUserId: string;
  onSave: (id: string, role: AccessRole, active: boolean) => Promise<void>;
}) {
  const pendingCount = users.filter((user) => user.active && user.role === "pending").length;
  return (
    <section className="user-management">
      {pendingCount > 0 && (
        <div className="pending-summary">
          <b>{pendingCount === 1 ? "1 uživatel čeká na schválení" : `${pendingCount} uživatelé čekají na schválení`}</b>
          <span>Čekající účty jsou zobrazené jako první.</span>
        </div>
      )}
      <p className="hint">
        Nové účty čekají na schválení. Role ani hlavního správce nelze změnit
        samotným uživatelem.
      </p>
      <div className="user-list">
        {users.map((user) => (
          <UserAccessCard
            key={user.id}
            user={user}
            isCurrent={user.id === currentUserId}
            onSave={onSave}
          />
        ))}
      </div>
      {users.length === 0 && (
        <p className="hint">Zatím nejsou dostupné žádné uživatelské profily.</p>
      )}
    </section>
  );
}

function UserAccessCard({
  user,
  isCurrent,
  onSave,
}: {
  user: UserProfile;
  isCurrent: boolean;
  onSave: (id: string, role: AccessRole, active: boolean) => Promise<void>;
}) {
  const [role, setRole] = useState(user.role);
  const [active, setActive] = useState(user.active);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setRole(user.role);
    setActive(user.active);
  }, [user.role, user.active]);
  const locked = user.isOwner;
  return (
    <article className={`user-card ${active ? "" : "inactive"} ${user.role === "pending" ? "pending" : ""}`}>
      <header>
        <span>
          <b>{user.fullName}</b>
          <small>{user.email || "E-mail není dostupný"}</small>
        </span>
        {user.isOwner && <strong>Hlavní správce</strong>}
      </header>
      <div className="user-dates">
        <small>První přihlášení: {formatProfileDate(user.firstSignedInAt)}</small>
        <small>
          Poslední přihlášení: {formatProfileDate(user.lastSignedInAt)}
        </small>
      </div>
      <label>
        Role
        <select
          value={role}
          disabled={locked}
          onChange={(event) => setRole(event.target.value as AccessRole)}
        >
          <option value="pending">Čeká na schválení</option>
          <option value="cleaning_team">Úklidový tým</option>
          <option value="visitor">Návštěvník</option>
          <option value="admin">Správce</option>
        </select>
      </label>
      <label className="switch">
        <input
          type="checkbox"
          checked={active}
          disabled={locked}
          onChange={(event) => setActive(event.target.checked)}
        />
        Aktivní účet
      </label>
      <button
        disabled={locked || saving || (role === user.role && active === user.active)}
        onClick={async () => {
          setSaving(true);
          try {
            await onSave(user.id, role, active);
          } finally {
            setSaving(false);
          }
        }}
      >
        {saving ? "Ukládám…" : isCurrent ? "Uložit můj profil" : "Uložit přístup"}
      </button>
    </article>
  );
}

function formatProfileDate(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("cs-CZ", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function cleaningDayHeading(context: CleaningDayContext, visibleCount: number) {
  if (context.kind === "preview") return "TESTOVACÍ NÁHLED";
  if (context.kind === "extraordinary") return "MIMOŘÁDNÝ ÚKLID";
  if (context.kind === "rescheduled") return "PŘESUNUTÝ ÚKLID";
  if (context.kind === "moved_away") return "ÚKLID PŘESUNUT";
  return visibleCount > 0 ? "STANDARDNÍ ÚKLID" : "ŽÁDNÝ ÚKLID DNES";
}

function cleaningDayDescription(context: CleaningDayContext) {
  if (context.kind === "preview") return "Pouze náhled, dokončování je vypnuté.";
  if (context.kind === "rescheduled") return `${context.title} · plán původně ${formatDate(context.scheduleDate)}`;
  if (context.kind === "extraordinary") return context.title;
  if (context.kind === "moved_away") return `Nový termín: ${formatDate(context.movedTo)}`;
  return "";
}

function formatDate(value?: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("cs-CZ").format(new Date(`${value}T12:00:00`));
}

function formatTaskSchedule(task: Task) {
  const floorVisit = task.cleaningCycleLength
    ? ` · při návštěvě ${task.floor.replace(/patro$/, "patra")}`
    : "";
  if (task.frequency === "měsíčně" && task.periodMonths) {
    const interval = task.periodMonths === 1 ? "1× měsíčně" : task.periodMonths === 2 ? "Každé 2 měsíce" : "Každé 3 měsíce";
    return `${interval} · ${task.periodWeek ?? 1}. týden období${floorVisit}`;
  }
  if (task.frequency === "měsíčně") return `1× měsíčně · ${task.monthlyDay ?? 1}. den`;
  if (task.frequency === "mimořádně") return "Mimořádně";
  const days = task.scheduleDays.map((day) => weekdays[day - 1]).filter(Boolean).join(" / ");
  const frequency = task.frequency === "denně" ? "Každý úklidový den" : task.frequency === "týdně" ? "1× týdně" : task.frequency;
  return `${frequency}${days ? ` · ${days}` : ""}${floorVisit}${task.active ? "" : " · neaktivní"}`;
}

function TodayExtras({ tasks, done, onComplete, pendingTaskIds }: {
  tasks: Task[];
  done: number;
  onComplete: (id: string) => Promise<void>;
  pendingTaskIds: Set<string>;
}) {
  return <section className="today-extras" aria-label="Dnešní práce navíc">
    <header><b>DNES NAVÍC</b>{tasks.length > 0 && <small>{done}/{tasks.length} hotovo</small>}</header>
    {tasks.length === 0 ? <p>Dnes nic navíc.</p> : <ul>{tasks
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((task) => {
        const pending = pendingTaskIds.has(task.id);
        return <li className={task.done ? "done" : ""} key={task.id}><button
          disabled={!task.canComplete || pending}
          onClick={() => void onComplete(task.id)}
          aria-pressed={task.done}
          aria-label={`${task.done ? "Zrušit dokončení" : "Dokončit"}: ${task.title}`}
        >
          <span aria-hidden="true">{pending ? "…" : task.done ? "✓" : activityTypes[task.activityType]?.icon ?? "✓"}</span>
          <span><b>{task.title}</b><small>{[task.building, task.floor, task.roomId ? task.room : null].filter(Boolean).join(" · ")}</small></span>
        </button></li>;
      })}</ul>}
  </section>;
}

function ArrivalReminders({ entries }: { entries: ManualEntry[] }) {
  if (!entries.length) return null;
  return <section className="arrival-reminders"><p className="eyebrow">PO PŘÍCHODU</p>{entries.sort((a, b) => a.sortOrder - b.sortOrder).map((entry) => <p key={entry.id}><span>☀</span><b>{entry.title}</b>{entry.body && <small>{entry.body}</small>}</p>)}</section>;
}

function ManualGuideModal({ entry, onClose }: { entry: ManualEntry; onClose: () => void }) {
  return <div className="confirmation-backdrop manual-modal" role="dialog" aria-modal="true" aria-label={entry.title} onClick={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <article className="confirmation-dialog manual-detail">
      <div className="manual-detail-heading"><span><p className="eyebrow">{entry.category}</p><h2>{entry.title}</h2></span><button onClick={onClose} aria-label="Zavřít návod">Zavřít</button></div>
      {entry.supplies && <section><h3>Co potřebuji</h3><p>{entry.supplies}</p></section>}
      {entry.steps && <section><h3>Jak postupovat</h3><p>{entry.steps}</p></section>}
      {entry.warnings && <section className="manual-warning"><h3>Na co si dát pozor</h3><p>{entry.warnings}</p></section>}
      {entry.schoolNote && <section><h3>Poznámka školy</h3><p>{entry.schoolNote}</p></section>}
      {entry.body && <p>{entry.body}</p>}
    </article>
  </div>;
}

function newManualEntry(entryType: ManualEntry["entryType"]): ManualEntry {
  return { id: "", entryType, title: "", category: entryType === "arrival" ? "Po příchodu" : "Ostatní", body: "", supplies: "", steps: "", warnings: "", schoolNote: "", markerColor: "", activityTypes: [], featured: false, active: true, sortOrder: 100 };
}

function ManualScreen({ data, tasks, onSave, onSetActive, onEditDeparture, onAddDeparture }: {
  data: ManualData; tasks: Task[];
  onSave: (entry: ManualEntry) => Promise<void>; onSetActive: (id: string, active: boolean) => Promise<void>;
  onEditDeparture: (task: Task) => void; onAddDeparture: () => void;
}) {
  const [search, setSearch] = useState("");
  const [manage, setManage] = useState(false);
  const [editingEntry, setEditingEntry] = useState<ManualEntry | null>(null);
  const [openGuide, setOpenGuide] = useState<ManualEntry | null>(null);
  const normalized = search.trim().toLocaleLowerCase("cs");
  const active = data.entries.filter((entry) => entry.active);
  const guides = active.filter((entry) => entry.entryType === "guide" && (!normalized || `${entry.title} ${entry.category} ${entry.supplies} ${entry.steps} ${entry.schoolNote}`.toLocaleLowerCase("cs").includes(normalized)));
  const practical = active.filter((entry) => entry.entryType === "practical" && (!normalized || `${entry.title} ${entry.category} ${entry.body}`.toLocaleLowerCase("cs").includes(normalized)));
  const arrival = active.filter((entry) => entry.entryType === "arrival");
  const departures = tasks.filter(isFinalCheckTask).sort((a, b) => a.sortOrder - b.sortOrder);
  if (!data.available) return <section className="panel"><h2>Manuál úklidu</h2><p>Manuál bude dostupný po aplikaci migrace 02000.</p></section>;
  if (editingEntry) return <ManualEntryEditor entry={editingEntry} onCancel={() => setEditingEntry(null)} onSave={async (entry) => { await onSave(entry); setEditingEntry(null); }} />;
  if (manage && data.editable) return <div className="manual-admin">
    <div className="manual-page-heading"><span><p className="eyebrow">SPRÁVA OBSAHU</p><h2>Manuál úklidu</h2></span><button onClick={() => setManage(false)}>Hotovo</button></div>
    <div className="manual-add-actions"><button onClick={() => setEditingEntry(newManualEntry("guide"))}>+ Návod</button><button onClick={() => setEditingEntry(newManualEntry("practical"))}>+ Praktická informace</button><button onClick={() => setEditingEntry(newManualEntry("arrival"))}>+ Připomínka po příchodu</button></div>
    {(["guide", "practical", "arrival"] as const).map((type) => <section className="panel" key={type}><h3>{type === "guide" ? "Návody" : type === "practical" ? "Praktické informace" : "Po příchodu"}</h3>{data.entries.filter((entry) => entry.entryType === type).sort((a, b) => Number(b.active) - Number(a.active) || a.sortOrder - b.sortOrder).map((entry) => <article className={`manual-admin-row${entry.active ? "" : " inactive"}`} key={entry.id}><span><b>{entry.title}</b><small>{entry.category} · pořadí {entry.sortOrder} · {entry.active ? "Aktivní" : "Neaktivní"}</small></span><div><button onClick={() => setEditingEntry(entry)}>Upravit</button><button onClick={() => void onSetActive(entry.id, !entry.active)}>{entry.active ? "Deaktivovat" : "Obnovit"}</button></div></article>)}</section>)}
    <section className="panel"><h3>Před odchodem ze školy</h3><p className="hint">Povinné kontroly jsou skutečné úkoly a zachovávají historii dokončení.</p>{departures.map((task) => <article className={`manual-admin-row${task.active ? "" : " inactive"}`} key={task.id}><span><b>{task.title}</b><small>Pořadí {task.sortOrder} · {task.active ? "Aktivní" : "Neaktivní"}</small></span><button onClick={() => onEditDeparture(task)}>Upravit</button></article>)}<button className="add-task" onClick={onAddDeparture}>+ Přidat kontrolu před odchodem</button></section>
  </div>;
  const categories = [...new Set(guides.map((entry) => entry.category))];
  return <div className="manual-screen">
    <div className="manual-page-heading"><span><p className="eyebrow">RYCHLÁ POMOC PŘI PRÁCI</p><h2>Manuál úklidu</h2></span>{data.editable && <button onClick={() => setManage(true)}>Spravovat</button>}</div>
    <label className="manual-search">Hledat v Manuálu<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Např. okna nebo WC" /></label>
    {!normalized && guides.some((entry) => entry.featured) && <section><h3>Rychlé návody</h3><div className="manual-featured">{guides.filter((entry) => entry.featured).map((entry) => <button key={entry.id} onClick={() => setOpenGuide(entry)}>{activityTypes[entry.activityTypes[0] as ActivityType]?.icon ?? "ⓘ"}<b>{entry.title}</b></button>)}</div></section>}
    {practical.length > 0 && <section className="panel practical-info"><p className="eyebrow">PRAKTICKÉ INFORMACE ŠKOLY</p>{practical.sort((a, b) => a.sortOrder - b.sortOrder).map((entry) => <article key={entry.id}><i style={{ backgroundColor: entry.markerColor || "#dcebe7" }} /><span><b>{entry.title}</b><small>{entry.body}</small></span></article>)}</section>}
    {!normalized && arrival.length > 0 && <section className="panel"><p className="eyebrow">PO PŘÍCHODU</p>{arrival.sort((a, b) => a.sortOrder - b.sortOrder).map((entry) => <p key={entry.id}><b>{entry.title}</b>{entry.body && <small className="manual-block-small">{entry.body}</small>}</p>)}</section>}
    {categories.map((category) => <section className="manual-category" key={category}><h3>{category}</h3><div>{guides.filter((entry) => entry.category === category).sort((a, b) => a.sortOrder - b.sortOrder).map((entry) => <button key={entry.id} onClick={() => setOpenGuide(entry)}><span>{activityTypes[entry.activityTypes[0] as ActivityType]?.icon ?? "ⓘ"}</span><b>{entry.title}</b><i>›</i></button>)}</div></section>)}
    {!guides.length && !practical.length && <p className="hint">Pro hledaný výraz nebyl nalezen žádný návod.</p>}
    {openGuide && <ManualGuideModal entry={openGuide} onClose={() => setOpenGuide(null)} />}
  </div>;
}

function ManualEntryEditor({ entry, onCancel, onSave }: { entry: ManualEntry; onCancel: () => void; onSave: (entry: ManualEntry) => Promise<void> }) {
  const [draft, setDraft] = useState(entry);
  const [saving, setSaving] = useState(false);
  const update = <K extends keyof ManualEntry>(key: K, value: ManualEntry[K]) => setDraft((current) => ({ ...current, [key]: value }));
  return <form className="task-editor manual-editor" onSubmit={async (event) => { event.preventDefault(); if (saving) return; setSaving(true); try { await onSave(draft); } finally { setSaving(false); } }}>
    <h2>{entry.id ? "Upravit položku" : "Nová položka Manuálu"}</h2>
    <label>Typ<select value={draft.entryType} onChange={(event) => update("entryType", event.target.value as ManualEntry["entryType"])}><option value="guide">Návod</option><option value="practical">Praktická informace</option><option value="arrival">Po příchodu</option></select></label>
    <label>Název<input required value={draft.title} onChange={(event) => update("title", event.target.value)} /></label>
    <label>Kategorie<input required value={draft.category} onChange={(event) => update("category", event.target.value)} /></label>
    {draft.entryType === "guide" && <>
      <label>Co potřebuji<textarea rows={3} value={draft.supplies} onChange={(event) => update("supplies", event.target.value)} /></label>
      <label>Jak postupovat<textarea rows={4} value={draft.steps} onChange={(event) => update("steps", event.target.value)} /></label>
      <label>Na co si dát pozor<textarea rows={3} value={draft.warnings} onChange={(event) => update("warnings", event.target.value)} /></label>
      <label>Poznámka školy<textarea rows={3} value={draft.schoolNote} onChange={(event) => update("schoolNote", event.target.value)} /></label>
      <fieldset><legend>Ukázat u kategorií úkolů</legend><div className="activity-type-checks">{(Object.entries(activityTypes) as [ActivityType, { icon: string; label: string }][]).map(([type, value]) => <label key={type}><input type="checkbox" checked={draft.activityTypes.includes(type)} onChange={(event) => update("activityTypes", event.target.checked ? [...draft.activityTypes, type] : draft.activityTypes.filter((item) => item !== type))} />{value.icon} {value.label}</label>)}</div></fieldset>
      <label className="switch"><input type="checkbox" checked={draft.featured} onChange={(event) => update("featured", event.target.checked)} /> Rychlý návod nahoře</label>
    </>}
    {draft.entryType !== "guide" && <label>Text<textarea rows={3} value={draft.body} onChange={(event) => update("body", event.target.value)} /></label>}
    {draft.entryType === "practical" && <label>Barevná značka<input type="color" value={draft.markerColor || "#dcebe7"} onChange={(event) => update("markerColor", event.target.value)} /></label>}
    <label>Pořadí<input type="number" value={draft.sortOrder} onChange={(event) => update("sortOrder", Number(event.target.value))} /></label>
    <label className="switch"><input type="checkbox" checked={draft.active} onChange={(event) => update("active", event.target.checked)} /> Aktivní</label>
    <div className="editor-actions"><button type="button" onClick={onCancel}>Zrušit</button><button disabled={saving}>{saving ? "Ukládám…" : "Uložit"}</button></div>
  </form>;
}

type PlanningWorkerOption = { id: string; name: string };

function PlanningWorkerEditor({ item, profiles, onCancel, onSave }: { item: PlanningWorker; profiles: AttendanceWorker[]; onCancel: () => void; onSave: (item: PlanningWorker) => Promise<void> }) {
  const [draft, setDraft] = useState(item);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  return <form className="task-editor worker-plan-editor" onSubmit={async (event) => { event.preventDefault(); if (saving) return; setSaving(true); setSaveError(""); try { await onSave(draft); onCancel(); } catch (error) { setSaveError(workerPlanningSaveError(error, "Pracovníka se nepodařilo uložit.")); } finally { setSaving(false); } }}>
    <h2>{item.id ? "Upravit pracovníka" : "Přidat pracovníka"}</h2>
    <label>Jméno / zobrazovaný název<input required maxLength={120} value={draft.name} onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))} /></label>
    <label>Propojit s uživatelem aplikace<select value={draft.linkedProfileId ?? ""} onChange={(event) => setDraft((value) => ({ ...value, linkedProfileId: event.target.value || null }))}><option value="">Bez účtu</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
    <p className="hint">Účet není potřeba. Propojení pouze spojí plán s existujícím uživatelem aplikace.</p>
    <label className="switch"><input type="checkbox" checked={draft.active} onChange={(event) => setDraft((value) => ({ ...value, active: event.target.checked }))} /> Aktivní</label>
    {saveError && <div className="notice error" role="alert">{saveError}</div>}
    <div className="editor-actions"><button type="button" onClick={onCancel}>Zrušit</button><button disabled={saving}>{saving ? "Ukládám…" : "Uložit"}</button></div>
  </form>;
}

function WorkerAssignmentEditor({ item, workers, options, onCancel, onSave }: { item: WorkerWorkAssignment; workers: PlanningWorkerOption[]; options: PlanOptions; onCancel: () => void; onSave: (item: WorkerWorkAssignment) => Promise<void> }) {
  const [draft, setDraft] = useState(item);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const floors = options.floors.filter((floor) => floor.buildingId === draft.buildingId);
  const update = <K extends keyof WorkerWorkAssignment>(key: K, value: WorkerWorkAssignment[K]) => setDraft((current) => ({ ...current, [key]: value }));
  return <form className="task-editor worker-plan-editor" onSubmit={async (event) => { event.preventDefault(); if (saving) return; setSaving(true); setSaveError(""); try { await onSave(draft); onCancel(); } catch (error) { setSaveError(workerPlanningSaveError(error, "Pracovní rozdělení se nepodařilo uložit.")); } finally { setSaving(false); } }}>
    <h2>{item.id ? "Upravit pracovní období" : "Nové pracovní období"}</h2>
    <label>Pracovník<select required value={draft.workerId} onChange={(event) => update("workerId", event.target.value)}><option value="">Vyberte pracovníka</option>{workers.map((worker) => <option key={worker.id} value={worker.id}>{worker.name}</option>)}</select></label>
    <label>Pracoviště<select required value={draft.buildingId} onChange={(event) => setDraft((current) => ({ ...current, buildingId: event.target.value, floorId: null }))}><option value="">Vyberte pracoviště</option>{options.buildings.map((building) => <option key={building.id} value={building.id}>{building.name}</option>)}</select></label>
    <label>Patro / sekce<select value={draft.floorId ?? ""} onChange={(event) => { const floor = floors.find((value) => value.id === event.target.value); setDraft((current) => ({ ...current, floorId: floor?.id ?? null, floorName: floor?.name ?? null, areaLabel: floor?.name || current.areaLabel })); }}><option value="">Vlastní oblast</option>{floors.map((floor) => <option key={floor.id} value={floor.id}>{floor.name}</option>)}</select></label>
    <label>Oblast<input required maxLength={120} value={draft.areaLabel} onChange={(event) => update("areaLabel", event.target.value)} placeholder="Např. 1. patro" /></label>
    <fieldset><legend>Pracovní dny</legend><div className="weekday-checks">{weekdays.map((day, index) => <label key={day}><input type="checkbox" checked={draft.weekdays.includes(index + 1)} onChange={(event) => update("weekdays", event.target.checked ? [...draft.weekdays, index + 1].sort() : draft.weekdays.filter((value) => value !== index + 1))} />{day}</label>)}</div></fieldset>
    <div className="period-fields"><label>Platí od<input required type="date" value={draft.validFrom} onChange={(event) => update("validFrom", event.target.value)} /></label><label>Platí do<input type="date" value={draft.validTo ?? ""} min={draft.validFrom} onChange={(event) => update("validTo", event.target.value || null)} /></label></div>
    <label className="switch"><input type="checkbox" checked={draft.active} onChange={(event) => update("active", event.target.checked)} /> Aktivní</label>
    {saveError && <div className="notice error" role="alert">{saveError}</div>}
    <div className="editor-actions"><button type="button" onClick={onCancel}>Zrušit</button><button disabled={saving || !draft.weekdays.length}>{saving ? "Ukládám…" : "Uložit"}</button></div>
  </form>;
}

function WorkerExceptionEditor({ item, workers, options, onCancel, onSave }: { item: WorkerScheduleException; workers: PlanningWorkerOption[]; options: PlanOptions; onCancel: () => void; onSave: (item: WorkerScheduleException) => Promise<void> }) {
  const [draft, setDraft] = useState(item);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const floors = options.floors.filter((floor) => floor.buildingId === draft.buildingId);
  const update = <K extends keyof WorkerScheduleException>(key: K, value: WorkerScheduleException[K]) => setDraft((current) => ({ ...current, [key]: value }));
  return <form className="task-editor worker-plan-editor" onSubmit={async (event) => { event.preventDefault(); if (saving) return; setSaving(true); setSaveError(""); try { await onSave(draft); onCancel(); } catch (error) { setSaveError(workerPlanningSaveError(error, "Výjimku rozvrhu se nepodařilo uložit.")); } finally { setSaving(false); } }}>
    <h2>{item.id ? "Upravit výjimku" : "Nová výjimka rozvrhu"}</h2>
    <label>Pracovník<select required value={draft.workerId} onChange={(event) => update("workerId", event.target.value)}><option value="">Vyberte pracovníka</option>{workers.map((worker) => <option key={worker.id} value={worker.id}>{worker.name}</option>)}</select></label>
    <label>Datum<input required type="date" value={draft.date} onChange={(event) => update("date", event.target.value)} /></label>
    <label>Typ změny<select value={draft.planned ? "planned" : "absent"} onChange={(event) => update("planned", event.target.value === "planned")}><option value="absent">Nepřijde</option><option value="planned">Výjimečně přijde / jiné pracoviště</option></select></label>
    {draft.planned && <><label>Pracoviště<select required value={draft.buildingId ?? ""} onChange={(event) => setDraft((current) => ({ ...current, buildingId: event.target.value, floorId: null }))}><option value="">Vyberte pracoviště</option>{options.buildings.map((building) => <option key={building.id} value={building.id}>{building.name}</option>)}</select></label><label>Patro / sekce<select value={draft.floorId ?? ""} onChange={(event) => { const floor = floors.find((value) => value.id === event.target.value); setDraft((current) => ({ ...current, floorId: floor?.id ?? null, floorName: floor?.name ?? null, areaLabel: floor?.name || current.areaLabel })); }}><option value="">Vlastní oblast</option>{floors.map((floor) => <option key={floor.id} value={floor.id}>{floor.name}</option>)}</select></label><label>Oblast<input value={draft.areaLabel ?? ""} onChange={(event) => update("areaLabel", event.target.value)} /></label></>}
    <label>Poznámka<textarea rows={2} value={draft.note} onChange={(event) => update("note", event.target.value)} /></label>
    <label className="switch"><input type="checkbox" checked={draft.active} onChange={(event) => update("active", event.target.checked)} /> Aktivní</label>
    {saveError && <div className="notice error" role="alert">{saveError}</div>}
    <div className="editor-actions"><button type="button" onClick={onCancel}>Zrušit</button><button disabled={saving}>{saving ? "Ukládám…" : "Uložit"}</button></div>
  </form>;
}

function FourthFloorRotationEditor({ data, workers, canManage, onSave }: { data: WorkerPlanningData; workers: PlanningWorkerOption[]; canManage: boolean; onSave: (slotIndex: number, workerId: string | null, effectiveFrom: string) => Promise<void> }) {
  const today = localDateKey();
  const definition = data.rotationDefinitions.find((item) => item.rotationKey === "school-fourth-floor" && item.active);
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [draft, setDraft] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState<number | null>(null);
  const currentFor = (slotIndex: number) => data.rotationSlots.filter((item) => item.rotationKey === "school-fourth-floor" && item.slotIndex === slotIndex && item.active && item.validFrom <= effectiveFrom && (!item.validTo || item.validTo >= effectiveFrom)).sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0];
  useEffect(() => {
    if (!definition) return;
    setDraft(Object.fromEntries(fourthFloorSlotIndices.map((slot) => [slot, currentFor(slot)?.workerId ?? ""])));
  }, [data.rotationSlots, definition?.rotationKey, effectiveFrom]);
  if (!definition) return <section className="panel rotation-editor"><p className="eyebrow">ROTACE 4. PATRA</p><p className="hint">Rotace bude dostupná po aplikaci migrace 03300.</p></section>;
  return <section className="panel rotation-editor"><p className="eyebrow">ROTACE 4. PATRA</p><h2>Pořadí pracovníků</h2><p className="hint">Planner vybere vhodnou směnu podle počtu pracovníků. Pozice určují pořadí skutečných pracovníků.</p>{canManage && <label>Platnost změny od<input type="date" value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} /></label>}<div className="rotation-slots">{fourthFloorSlotIndices.map((slot) => <div key={slot}><b>Pozice {String.fromCharCode(65 + slot)}</b><select disabled={!canManage || saving !== null} value={draft[slot] ?? currentFor(slot)?.workerId ?? ""} onChange={(event) => setDraft((value) => ({ ...value, [slot]: event.target.value }))}><option value="">Zatím nepřiřazena</option>{workers.map((worker) => <option value={worker.id} key={worker.id}>{worker.name}</option>)}</select>{canManage && <button disabled={saving !== null} onClick={async () => { setSaving(slot); try { await onSave(slot, draft[slot] || null, effectiveFrom); } finally { setSaving(null); } }}>{saving === slot ? "Ukládám…" : "Uložit pozici"}</button>}</div>)}</div></section>;
}

function WorkAssignmentOverview({ data, profiles, options, canManage, onSaveWorker, onSaveAssignment, onSaveException, onSaveRotation }: { data: WorkerPlanningData; profiles: AttendanceWorker[]; options: PlanOptions; canManage: boolean; onSaveWorker: (item: PlanningWorker) => Promise<void>; onSaveAssignment: (item: WorkerWorkAssignment) => Promise<void>; onSaveException: (item: WorkerScheduleException) => Promise<void>; onSaveRotation: (slotIndex: number, workerId: string | null, effectiveFrom: string) => Promise<void> }) {
  const today = localDateKey();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [assignment, setAssignment] = useState<WorkerWorkAssignment | null>(null);
  const [exception, setException] = useState<WorkerScheduleException | null>(null);
  const [editingWorker, setEditingWorker] = useState<PlanningWorker | null>(null);
  const planningWorkers = data.planningWorkers ?? profiles.map((profile) => ({ id: profile.id, name: profile.name, linkedProfileId: profile.id, active: true }));
  const workerOptions = planningWorkers.filter((worker) => worker.active).map(({ id, name }) => ({ id, name }));
  const current = data.assignments.filter((item) => assignmentOverlapsMonth(item, month));
  const blankAssignment = (): WorkerWorkAssignment => ({ id: "", workerId: "", workerName: "", buildingId: "", buildingName: "", floorId: null, floorName: null, areaLabel: "", weekdays: [1, 3, 5], validFrom: today, validTo: null, active: true });
  const blankException = (): WorkerScheduleException => ({ id: "", workerId: "", workerName: "", date: today, planned: false, buildingId: null, buildingName: null, floorId: null, floorName: null, areaLabel: null, note: "", active: true });
  const saveAssignment = async (item: WorkerWorkAssignment) => {
    if (data.assignments.some((existing) => workAssignmentsConflict(existing, item))) {
      throw new Error("Toto období se překrývá s již uloženým pracovním obdobím. Otevřete existující období a upravte ho.");
    }
    await onSaveAssignment(item);
  };
  const saveException = async (item: WorkerScheduleException) => {
    if (data.exceptions.some((existing) => scheduleExceptionsConflict(existing, item))) {
      throw new Error("Pro tohoto pracovníka už je na vybraný den uložená výjimka. Otevřete ji a upravte.");
    }
    await onSaveException(item);
  };
  return <div className="work-assignment-screen">
    <section className="panel planning-worker-panel"><div className="section-heading"><span><p className="eyebrow">PRACOVNÍCI</p><h2>Lidé v pracovním plánu</h2></span>{canManage && data.planningWorkers && <button onClick={() => setEditingWorker({ id: "", name: "", linkedProfileId: null, active: true })}>+ Přidat pracovníka</button>}</div><div className="planning-worker-list">{planningWorkers.map((worker) => <button key={worker.id} disabled={!canManage || !data.planningWorkers} onClick={() => setEditingWorker(worker)}><span><b>{worker.name}{!worker.active ? " · Neaktivní" : ""}</b><small>{worker.linkedProfileId ? "Účet propojen" : "Bez účtu"}</small></span>{canManage && data.planningWorkers && <strong>Upravit ›</strong>}</button>)}</div></section>
    {editingWorker && <PlanningWorkerEditor item={editingWorker} profiles={profiles} onCancel={() => setEditingWorker(null)} onSave={onSaveWorker} />}
    <section className="panel"><p className="eyebrow">ROZDĚLENÍ PRÁCE</p><h2>Stabilní pracovní oblasti</h2><p className="hint">Pracovní dny určují počet lidí; planner podle něj zvolí rozsah úklidu.</p>{!data.available && <div className="notice">Databázový model ještě není aktivní.</div>}{canManage && data.available && <div className="worker-plan-actions"><button onClick={() => { setException(null); setAssignment(blankAssignment()); }}>+ Přidat nové období</button><button onClick={() => { setAssignment(null); setException(blankException()); }}>+ Přidat výjimku</button></div>}</section>
    {assignment && <WorkerAssignmentEditor item={assignment} workers={workerOptions} options={options} onCancel={() => setAssignment(null)} onSave={saveAssignment} />}
    {exception && <WorkerExceptionEditor item={exception} workers={workerOptions} options={options} onCancel={() => setException(null)} onSave={saveException} />}
    <FourthFloorRotationEditor data={data} workers={workerOptions} canManage={canManage} onSave={onSaveRotation} />
    <label className="worker-plan-month">Zobrazený měsíc<input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label>
    <section className="worker-assignment-list">{current.map((item) => <button className={item.active ? "" : "inactive"} key={item.id} disabled={!canManage} onClick={() => { setException(null); setAssignment(item); }}><span><b>{item.workerName}{!item.active ? " · Neaktivní" : ""}</b><small>{item.buildingName} · {item.areaLabel}</small><em>{weekdays.filter((_, index) => item.weekdays.includes(index + 1)).join(" · ")}</em><i>{formatDate(item.validFrom)}{item.validTo ? ` – ${formatDate(item.validTo)}` : " – bez konce"}</i></span>{canManage && <strong>Upravit ›</strong>}</button>)}{data.available && current.length === 0 && <p className="hint">Pro tento měsíc zatím není uložené žádné pracovní rozdělení.</p>}</section>
    {data.exceptions.length > 0 && <details className="worker-exception-list"><summary>Výjimky rozvrhu</summary>{data.exceptions.slice().sort((a, b) => b.date.localeCompare(a.date)).map((item) => <button key={item.id} disabled={!canManage} onClick={() => setException(item)}><b>{formatDate(item.date)} · {item.workerName}</b><span>{item.planned ? `Výjimečně: ${item.buildingName ?? "pracoviště"} · ${item.areaLabel ?? "oblast"}` : "Nepřijde"}</span>{item.note && <small>{item.note}</small>}</button>)}</details>}
  </div>;
}

function MoreScreen({
  profile,
  pendingCount,
  onOpenPlan,
  onOpenRooms,
  onOpenUsers,
  onOpenCleaningDays,
  onOpenAssignments,
  onOpenManual,
  workplaces,
  appSettings,
  onSaveWorkplace,
  onSaveDppLimit,
  onSaveDpcSettings,
}: {
  profile: Profile;
  pendingCount: number;
  onOpenPlan: () => void;
  onOpenRooms: () => void;
  onOpenUsers: () => Promise<void>;
  onOpenCleaningDays: () => void;
  onOpenAssignments: () => void;
  onOpenManual: () => void;
  workplaces: Workplace[];
  appSettings: AppSettings;
  onSaveWorkplace: (workplace: Workplace) => Promise<void>;
  onSaveDppLimit: (value: number) => Promise<void>;
  onSaveDpcSettings: (weeklyHours: number, referenceWeeks: number, monthlyThreshold: number) => Promise<void>;
}) {
  const admin = canManageOperations(profile);
  return (
    <div className="more-screen">
      {profile.is_owner && pendingCount > 0 && (
        <button className="pending-alert" onClick={() => void onOpenUsers()}>
          <b>{pendingCount === 1 ? "1 uživatel čeká na schválení" : `${pendingCount} uživatelé čekají na schválení`}</b>
          <span>Otevřít správu uživatelů</span>
        </button>
      )}
      <section className="panel manual-menu-link">
        <button onClick={onOpenManual}><span><b>Manuál úklidu</b><small>Návody a praktické informace školy</small></span><i>›</i></button>
      </section>
      {admin && (
        <section className="panel admin-menu">
          <p className="eyebrow">SPRÁVA APLIKACE</p>
          <button onClick={onOpenPlan}><span><b>Plán úklidu</b><small>Patra, místnosti a činnosti</small></span><i>›</i></button>
          <button onClick={onOpenRooms}><span><b>Místnosti</b><small>Struktura školy a aktivní místnosti</small></span><i>›</i></button>
          <button onClick={onOpenCleaningDays}><span><b>Úklidové dny</b><small>Mimořádné úklidy a přesuny</small></span><i>›</i></button>
          <button onClick={onOpenAssignments}><span><b>Pracovní rozdělení</b><small>Pracovníci, oblasti, dny a výjimky</small></span><i>›</i></button>
          {profile.is_owner && (
            <button onClick={() => void onOpenUsers()}>
              <span><b>Uživatelé</b><small>Role a čekající účty</small></span>
              <i>{pendingCount > 0 ? pendingCount : "›"}</i>
            </button>
          )}
        </section>
      )}
      <section className="panel">
        <p className="eyebrow">NASTAVENÍ</p>
        <h2>Pracoviště</h2>
        <WorkplaceSettings
          workplaces={admin ? workplaces : workplaces.filter((item) => item.active)}
          canManage={admin}
          onSave={onSaveWorkplace}
        />
        <h2>Docházka</h2>
        <DppLimitSetting
          value={appSettings.dppAnnualLimitHours}
          editable={admin && appSettings.available}
          available={appSettings.available}
          onSave={onSaveDppLimit}
        />
        <DpcSettings
          value={appSettings.dpcWeeklyHoursReference}
          weeks={appSettings.dpcReferencePeriodWeeks}
          threshold={appSettings.dpcMonthlyInsuranceThreshold}
          editable={admin && appSettings.compensationAvailable}
          onSave={onSaveDpcSettings}
        />
        <p className="hint">Přihlášen: {profile.full_name} · {roleLabel(accessRole(profile))}</p>
      </section>
    </div>
  );
}

function DpcSettings({ value, weeks, threshold, editable, onSave }: { value: number; weeks: number; threshold: number; editable: boolean; onSave: (value: number, weeks: number, threshold: number) => Promise<void> }) {
  const [hours, setHours] = useState(value);
  const [period, setPeriod] = useState(weeks);
  const [monthlyThreshold, setMonthlyThreshold] = useState(threshold);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setHours(value); setPeriod(weeks); setMonthlyThreshold(threshold); }, [value, weeks, threshold]);
  return <div className="dpp-setting"><label>Rozhodný měsíční příjem DPČ<input type="number" min="1" max="1000000" step="1" value={monthlyThreshold} disabled={!editable} onChange={(event) => setMonthlyThreshold(Number(event.target.value))} /></label><span>Kč · evidenční hranice pro měsíční odhad</span><label>Referenční průměrný týdenní rozsah DPČ<input type="number" min="1" max="80" step="0.5" value={hours} disabled={!editable} onChange={(event) => setHours(Number(event.target.value))} /></label><span>hodin týdně · není to potřebné minimum</span><label>Referenční období<input type="number" min="1" max="52" value={period} disabled={!editable} onChange={(event) => setPeriod(Number(event.target.value))} /></label><span>týdnů</span>{editable && <button disabled={saving || (hours === value && period === weeks && monthlyThreshold === threshold)} onClick={async () => { setSaving(true); try { await onSave(hours, period, monthlyThreshold); } finally { setSaving(false); } }}>{saving ? "Ukládám…" : "Uložit DPČ"}</button>}</div>;
}

function WorkplaceSettings({
  workplaces,
  canManage,
  onSave,
}: {
  workplaces: Workplace[];
  canManage: boolean;
  onSave: (workplace: Workplace) => Promise<void>;
}) {
  const [editing, setEditing] = useState<Workplace | "new" | null>(null);
  return (
    <div className="workplace-settings">
      {workplaces.map((workplace) => (
        <button
          key={workplace.id}
          disabled={!canManage}
          onClick={() => setEditing(workplace)}
        >
          <span><b>{workplace.name}</b><small>{workplace.active ? "Aktivní" : "Neaktivní"}</small></span>
          {canManage && <i>Upravit</i>}
        </button>
      ))}
      {canManage && (
        <button className="add-workplace" onClick={() => setEditing("new")}>
          + Přidat pracoviště
        </button>
      )}
      {editing && (
        <WorkplaceEditor
          workplace={editing === "new" ? undefined : editing}
          onCancel={() => setEditing(null)}
          onSave={async (value) => {
            await onSave(value);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function WorkplaceEditor({
  workplace,
  onCancel,
  onSave,
}: {
  workplace?: Workplace;
  onCancel: () => void;
  onSave: (workplace: Workplace) => Promise<void>;
}) {
  const [name, setName] = useState(workplace?.name ?? "");
  const [active, setActive] = useState(workplace?.active ?? true);
  const [saving, setSaving] = useState(false);
  return (
    <form
      className="operation-editor"
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        try {
          await onSave({ id: workplace?.id ?? "", name, active });
        } finally {
          setSaving(false);
        }
      }}
    >
      <label>Název<input required minLength={2} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label className="switch"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} /> Aktivní pracoviště</label>
      <div className="editor-actions"><button type="button" onClick={onCancel}>Zrušit</button><button disabled={saving}>{saving ? "Ukládám…" : "Uložit"}</button></div>
    </form>
  );
}

function DppLimitSetting({
  value,
  editable,
  available,
  onSave,
}: {
  value: number;
  editable: boolean;
  available: boolean;
  onSave: (value: number) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(value), [value]);
  return (
    <div className="dpp-setting">
      <label>Roční limit DPP<input type="number" min="1" max="10000" step="0.5" value={draft} disabled={!editable} onChange={(event) => setDraft(Number(event.target.value))} /></label>
      <span>hodin za kalendářní rok napříč všemi pracovišti</span>
      {editable && <button disabled={saving || draft === value} onClick={async () => { setSaving(true); try { await onSave(draft); } finally { setSaving(false); } }}>{saving ? "Ukládám…" : "Uložit limit"}</button>}
      {!available && <small>Nastavení bude editovatelné po aplikaci migrace 01600. Do té doby aplikace bezpečně používá 300 hodin.</small>}
    </div>
  );
}

function ProfileEditor({
  profile,
  onCancel,
  onSave,
}: {
  profile: Profile;
  onCancel: () => void;
  onSave: (fullName: string) => Promise<void>;
}) {
  const [fullName, setFullName] = useState(profile.full_name);
  const [saving, setSaving] = useState(false);
  return (
    <div className="confirmation-backdrop" role="dialog" aria-modal="true" aria-label="Upravit profil">
      <form className="confirmation-dialog profile-editor" onSubmit={async (event) => { event.preventDefault(); setSaving(true); try { await onSave(fullName); } finally { setSaving(false); } }}>
        <h2>Upravit profil</h2>
        <label>Zobrazované jméno<input value={fullName} minLength={2} maxLength={100} required onChange={(event) => setFullName(event.target.value)} /></label>
        <label>E-mail<input value={profile.email ?? ""} readOnly /></label>
        <label>Role<input value={roleLabel(accessRole(profile))} readOnly /></label>
        <div className="confirmation-actions"><button type="button" onClick={onCancel}>Zrušit</button><button className="primary" disabled={saving}>{saving ? "Ukládám…" : "Uložit profil"}</button></div>
      </form>
    </div>
  );
}

function OperationsScreen({
  data,
  userId,
  canCreate,
  canManage,
  onChanged,
}: {
  data: OperationsData;
  userId: string;
  canCreate: boolean;
  canManage: boolean;
  onChanged: () => Promise<void>;
}) {
  const [purchaseEditor, setPurchaseEditor] = useState<StockItem | "new" | null>(null);
  const [incidentEditor, setIncidentEditor] = useState<Incident | "new" | null>(null);
  const [message, setMessage] = useState("");
  const [mutating, setMutating] = useState(false);
  const mutationLock = useRef(false);
  const buildingName = (buildingId?: string | null) => data.buildings.find((building) => building.id === buildingId)?.name ?? "Pracoviště neuvedeno";
  const needed = data.stock.filter((item) => item.status === "needed");
  const bought = data.stock.filter((item) => item.status === "resolved");
  const openIncidents = data.incidents.filter((item) => item.status !== "resolved");
  const resolvedIncidents = data.incidents.filter((item) => item.status === "resolved");
  const mutate = async (action: () => Promise<void>) => {
    if (mutationLock.current) return;
    mutationLock.current = true;
    setMutating(true);
    try {
      setMessage("");
      await action();
      await onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Změnu se nepodařilo uložit.");
      throw error;
    } finally {
      mutationLock.current = false;
      setMutating(false);
    }
  };
  return (
    <div className="operations-screen">
      {message && <div className="notice">{message}</div>}
      {!data.editable && canCreate && (
        <div className="notice">Editace Provozu bude dostupná po aplikaci migrace 01500.</div>
      )}
      <section className="panel">
        <div className="operation-heading">
          <p className="eyebrow">CO CHYBÍ / CO KOUPIT</p>
          {canCreate && data.editable && <button onClick={() => setPurchaseEditor("new")}>+ Přidat</button>}
        </div>
        {purchaseEditor && (
          <PurchaseEditor
            item={purchaseEditor === "new" ? undefined : purchaseEditor}
            buildings={data.buildings}
            onCancel={() => setPurchaseEditor(null)}
            onSave={async (draft) => {
              await mutate(() => schoolRepository.savePurchaseItem(draft, userId));
              setPurchaseEditor(null);
            }}
          />
        )}
        {needed.map((item) => (
          <article className="operation-card" key={item.id}>
            <div><b>{item.name}</b><small>{buildingName(item.buildingId)}</small>{item.note && <span>{item.note}</span>}</div>
            {(canManage || item.createdBy === userId) && data.editable && (
              <div className="operation-actions">
                <button disabled={mutating} onClick={() => setPurchaseEditor(item)}>Upravit</button>
                <button disabled={mutating} className="success" onClick={() => void mutate(() => schoolRepository.setPurchaseItemStatus(item.id, "resolved")).catch(() => undefined)}>{mutating ? "Ukládám…" : "Koupeno"}</button>
                <button disabled={mutating} onClick={() => void mutate(() => schoolRepository.archivePurchaseItem(item.id)).catch(() => undefined)}>Skrýt</button>
              </div>
            )}
          </article>
        ))}
        {!needed.length && <p className="hint">Momentálně není potřeba nic koupit.</p>}
        {!!bought.length && (
          <details className="resolved-items">
            <summary>Vyřešené ({bought.length})</summary>
            {bought.map((item) => (
              <article className="operation-card resolved" key={item.id}>
                <div><b>{item.name}</b><small>{buildingName(item.buildingId)}</small>{item.note && <span>{item.note}</span>}</div>
                {(canManage || item.createdBy === userId) && data.editable && <div className="operation-actions"><button disabled={mutating} onClick={() => void mutate(() => schoolRepository.setPurchaseItemStatus(item.id, "needed")).catch(() => undefined)}>{mutating ? "Ukládám…" : "Znovu otevřít"}</button><button disabled={mutating} onClick={() => void mutate(() => schoolRepository.archivePurchaseItem(item.id)).catch(() => undefined)}>Archivovat</button></div>}
              </article>
            ))}
          </details>
        )}
      </section>
      <section className="panel">
        <div className="operation-heading">
          <p className="eyebrow">CO JE ROZBITÉ / CO OPRAVIT</p>
          {canCreate && data.editable && <button onClick={() => setIncidentEditor("new")}>+ Nahlásit závadu</button>}
        </div>
        {incidentEditor && (
          <IncidentEditor
            item={incidentEditor === "new" ? undefined : incidentEditor}
            rooms={data.rooms}
            buildings={data.buildings}
            onCancel={() => setIncidentEditor(null)}
            onSave={async (draft) => {
              await mutate(() => schoolRepository.saveIncident(draft, userId));
              setIncidentEditor(null);
            }}
          />
        )}
        {openIncidents.map((item) => (
          <article className="operation-card incident" key={item.id}>
            <div><b>⚠ {item.title}</b><small>{buildingName(item.buildingId)}</small><span>{[item.room, item.floor].filter(Boolean).join(" · ") || "Místo neuvedeno"}</span>{item.note && <small>{item.note}</small>}</div>
            {(canManage || item.createdBy === userId) && data.editable && (
              <div className="operation-actions">
                <button disabled={mutating} onClick={() => setIncidentEditor(item)}>Upravit</button>
                <button disabled={mutating} className="success" onClick={() => void mutate(() => schoolRepository.setIncidentStatus(item.id, "resolved")).catch(() => undefined)}>{mutating ? "Ukládám…" : "Opraveno"}</button>
                <button disabled={mutating} onClick={() => void mutate(() => schoolRepository.archiveIncident(item.id)).catch(() => undefined)}>Archivovat</button>
              </div>
            )}
          </article>
        ))}
        {!openIncidents.length && <p className="hint">Nejsou evidované žádné otevřené závady.</p>}
        {!!resolvedIncidents.length && (
          <details className="resolved-items">
            <summary>Vyřešené ({resolvedIncidents.length})</summary>
            {resolvedIncidents.map((item) => (
              <article className="operation-card resolved" key={item.id}>
                <div><b>{item.title}</b><small>{buildingName(item.buildingId)}</small><span>{[item.room, item.floor].filter(Boolean).join(" · ")}</span></div>
                {(canManage || item.createdBy === userId) && data.editable && <div className="operation-actions"><button disabled={mutating} onClick={() => void mutate(() => schoolRepository.setIncidentStatus(item.id, "reported")).catch(() => undefined)}>{mutating ? "Ukládám…" : "Znovu otevřít"}</button><button disabled={mutating} onClick={() => void mutate(() => schoolRepository.archiveIncident(item.id)).catch(() => undefined)}>Archivovat</button></div>}
              </article>
            ))}
          </details>
        )}
      </section>
    </div>
  );
}

function PurchaseEditor({ item, buildings, onSave, onCancel }: { item?: StockItem; buildings: Workplace[]; onSave: (item: { id?: string; name: string; note: string; buildingId: string }) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState(item?.name ?? "");
  const [note, setNote] = useState(item?.note ?? "");
  const [buildingId, setBuildingId] = useState(item?.buildingId ?? "");
  const [saving, setSaving] = useState(false);
  return (
    <form className="operation-editor" onSubmit={async (event) => { event.preventDefault(); setSaving(true); try { await onSave({ id: item?.id, name, note, buildingId }); } finally { setSaving(false); } }}>
      <label>Pracoviště<select value={buildingId} onChange={(event) => setBuildingId(event.target.value)} required><option value="">Vyberte pracoviště</option>{buildings.map((building) => <option key={building.id} value={building.id}>{building.name}</option>)}</select></label>
      <label>Název<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Např. Gumové rukavice" required /></label>
      <label>Poznámka<textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} placeholder="Volitelná upřesňující poznámka" /></label>
      <div className="editor-actions"><button type="button" onClick={onCancel}>Zrušit</button><button disabled={saving}>{saving ? "Ukládám…" : "Uložit"}</button></div>
    </form>
  );
}

function IncidentEditor({ item, rooms, buildings, onSave, onCancel }: { item?: Incident; rooms: OperationsData["rooms"]; buildings: Workplace[]; onSave: (item: { id?: string; title: string; note: string; buildingId: string; roomId?: string | null }) => Promise<void>; onCancel: () => void }) {
  const [title, setTitle] = useState(item?.title ?? "");
  const [note, setNote] = useState(item?.note ?? "");
  const [roomId, setRoomId] = useState(item?.roomId ?? "");
  const [buildingId, setBuildingId] = useState(item?.buildingId ?? "");
  const buildingRooms = forBuilding(rooms, buildingId);
  const [saving, setSaving] = useState(false);
  return (
    <form className="operation-editor" onSubmit={async (event) => { event.preventDefault(); setSaving(true); try { await onSave({ id: item?.id, title, note, buildingId, roomId: roomForBuilding(rooms, roomId, buildingId) }); } finally { setSaving(false); } }}>
      <label>Pracoviště<select value={buildingId} onChange={(event) => { setBuildingId(event.target.value); setRoomId(""); }} required><option value="">Vyberte pracoviště</option>{buildings.map((building) => <option key={building.id} value={building.id}>{building.name}</option>)}</select></label>
      <label>Co je rozbité<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Např. Nefunguje světlo" required /></label>
      <label>Místnost<select value={roomForBuilding(rooms, roomId, buildingId) ?? ""} onChange={(event) => setRoomId(event.target.value)} disabled={!buildingId}><option value="">Místo neuvedeno</option>{buildingRooms.map((room) => <option key={room.id} value={room.id}>{room.floor} · {room.name}</option>)}</select></label>
      <label>Poznámka<textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} placeholder="Volitelné upřesnění" /></label>
      <div className="editor-actions"><button type="button" onClick={onCancel}>Zrušit</button><button disabled={saving}>{saving ? "Ukládám…" : "Uložit"}</button></div>
    </form>
  );
}

function taskScheduleInput(task: Task) {
  return {
    id: task.id,
    frequency: task.frequency,
    schedule_days: task.scheduleDays,
    monthly_day: task.monthlyDay,
    cleaning_cycle_length: task.cleaningCycleLength,
    cleaning_cycle_offset: task.cleaningCycleOffset,
    period_months: task.periodMonths,
    period_week: task.periodWeek,
    period_anchor_month: task.periodAnchorMonth,
  };
}

function dueTasksForDate(tasks: Task[], records: CleaningDayRecord[], date: string) {
  return tasks.filter((task) => task.active && task.roomActive !== false)
    .filter((task) => {
      const context = resolveCleaningDay(date, records.filter((record) => !task.buildingId || record.buildingId === task.buildingId));
      return isTaskDueForCleaningDay(taskScheduleInput(task), context);
    });
}

function plannedTasksForDate(
  tasks: Task[],
  records: CleaningDayRecord[],
  date: string,
  serverTaskIds?: ReadonlySet<string>,
) {
  const fixed = dueTasksForDate(tasks, records, date);
  if (!serverTaskIds) return fixed;
  const schoolException = records.find((record) => record.buildingId && record.executionDate === date && record.status === "active");
  return tasks.filter((task) => task.active && task.roomActive !== false).filter((task) => {
    if (task.building !== "Škola" || schoolException?.kind === "extraordinary") return fixed.some((item) => item.id === task.id);
    return serverTaskIds.has(task.id);
  });
}

function serverPlanForCalendarDate(date: string, records: CleaningDayRecord[], plan: Map<string, Set<string>> | null) {
  if (!plan) return undefined;
  const movedAway = records.some((record) => record.status === "active" && record.kind === "rescheduled" && record.sourceDate === date);
  if (movedAway) return new Set<string>();
  const ids = new Set(plan.get(date) ?? []);
  const rescheduled = records.find((record) => record.status === "active" && record.kind === "rescheduled" && record.executionDate === date && record.sourceDate);
  if (rescheduled?.sourceDate) for (const id of plan.get(rescheduled.sourceDate) ?? []) ids.add(id);
  return ids;
}

function calendarContextForDate(tasks: Task[], records: CleaningDayRecord[], date: string) {
  const active = records.filter((record) => record.status === "active");
  const executing = active.find((record) => record.executionDate === date);
  if (executing) return resolveCleaningDay(date, [executing]);
  const moved = active.find((record) => record.kind === "rescheduled" && record.sourceDate === date);
  if (moved) return resolveCleaningDay(date, [moved]);
  const buildingIds = [...new Set(tasks.map((task) => task.buildingId).filter((id): id is string => Boolean(id)))];
  if (buildingIds.length === 1) return resolveCleaningDay(date, active.filter((record) => record.buildingId === buildingIds[0]));
  return resolveCleaningDay(date, []);
}

function CalendarDayCell({ summary, month, selected, onSelect }: { summary: CalendarDaySummary; month: string; selected: boolean; onSelect: (date: string, outside: boolean) => void }) {
  const outside = summary.date.slice(0, 7) !== month;
  const aria = [
    formatDate(summary.date),
    ...summary.workers.map((worker) => `${worker.workerName}, ${worker.buildingName}`),
    ...summary.extraCategories.map((category) => category.label),
    ...summary.extraordinary.map((title) => `Mimořádně: ${title}`),
    ...summary.rescheduled.map((title) => `Přesunuto: ${title}`),
    ...(summary.fourthFloorRotation ? [`4. patro: ${summary.fourthFloorRotation.assignment?.workerName ?? `pozice ${summary.fourthFloorRotation.slotLabel} zatím není přiřazena`}`] : []),
  ].join(", ");
  return <button
    className={`calendar-day${outside ? " outside" : ""}${summary.isWeekend ? " weekend" : ""}${summary.isToday ? " today" : ""}${selected ? " selected" : ""}${summary.workers.length || summary.extraCategories.length ? " has-work" : ""}${summary.workers.some((item) => item.buildingName === "Školka") ? " kindergarten-day" : ""}`}
    onClick={() => onSelect(summary.date, outside)}
    aria-label={aria}
  >
    <strong>{Number(summary.date.slice(8, 10))}</strong>
    {summary.workers.length > 0 && <span className="calendar-workers">{summary.workers.slice(0, 2).map((worker) => <i className={`worker-color-${worker.colorIndex}`} key={`${worker.workerId}|${worker.buildingId}`} title={`${worker.workerName} · ${worker.buildingName}`}>{worker.initials}</i>)}{summary.workers.length > 2 && <b>+{summary.workers.length - 2}</b>}</span>}
    {(summary.extraordinary.length > 0 || summary.rescheduled.length > 0 || summary.cancelledExceptions.length > 0 || summary.movedTo || summary.extraCategories.length > 0) && <span className="calendar-specials">
      {summary.extraordinary.length > 0 && <em>Mimořádně</em>}
      {summary.rescheduled.length > 0 && <em>Přesunuto</em>}
      {summary.cancelledExceptions.length > 0 && <em>Zrušeno</em>}
      {summary.movedTo && <em title={`Přesunuto na ${formatDate(summary.movedTo)}`}>Jiný termín</em>}
      <span className="calendar-extras-mobile">{summary.extraCategories.slice(0, 1).map((category) => <em key={category.key}><i>{category.symbol}</i>{category.label}</em>)}{summary.extraCategories.length > 1 && <b>+{summary.extraCategories.length - 1}</b>}</span>
      <span className="calendar-extras-desktop">{summary.extraCategories.slice(0, 2).map((category) => <em key={category.key}><i>{category.symbol}</i>{category.label}</em>)}{summary.extraCategories.length > 2 && <b>+{summary.extraCategories.length - 2} další</b>}</span>
      {summary.fourthFloorRotation && <em className="calendar-rotation">4. patro · {summary.fourthFloorRotation.assignment?.workerName ? summary.fourthFloorRotation.assignment.workerName.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() : `pozice ${summary.fourthFloorRotation.slotLabel}`}</em>}
    </span>}
  </button>;
}

function CalendarLegend() {
  return <details className="calendar-legend"><summary>Legenda</summary><div><span>Iniciály = pracovníci</span><span>OK = okna</span><span>DV = dveře</span><span>SCH = schodiště</span><span>PR = praní</span><small>Kalendář ukazuje jen pracovní rozdělení a práci navíc.</small></div></details>;
}

function CalendarDayDetail({ summary, onOpenAssignments }: { summary: CalendarDaySummary; onOpenAssignments: () => void }) {
  const { date, context } = summary;
  return (
    <section className="calendar-day-detail">
      <header><small>{summary.extraordinary.length ? "MIMOŘÁDNÝ ÚKLID" : summary.rescheduled.length ? "PŘESUNUTÝ ÚKLID" : context.kind === "moved_away" ? "PŘESUNUTÝ TERMÍN" : "PLÁN DNE"}</small><h2>{todayLabel(date)}</h2></header>
      {context.note && <p>{context.note}</p>}
      {summary.extraordinary.map((title) => <p className="calendar-extraordinary" key={title}><b>MIMOŘÁDNĚ</b><span>{title}</span></p>)}
      {summary.rescheduled.map((title) => <p className="calendar-rescheduled" key={title}><b>PŘESUNUTÝ ÚKLID</b><span>{title}</span></p>)}
      {summary.cancelledExceptions.map((title) => <p className="calendar-cancelled" key={title}><b>ZRUŠENÝ ÚKLID</b><span>{title}</span></p>)}
      {summary.movedTo && <p className="calendar-rescheduled"><b>ÚKLID PŘESUNUT</b><span>Nový termín: {formatDate(summary.movedTo)}</span></p>}
      <section className="calendar-day-summary"><b className="calendar-detail-label">V PRÁCI</b>{summary.workers.length > 0 ? <div className="calendar-worker-list">{summary.workers.map((worker) => <span key={`${worker.workerId}|${worker.buildingId}`}><i className={`worker-color-${worker.colorIndex}`}>{worker.initials}</i><b>{worker.workerName}</b><small>{worker.buildingName} · {worker.areaLabel}{worker.exception ? " · výjimečně" : ""}</small></span>)}</div> : <p className="hint">Nikdo není podle rozvrhu naplánovaný.</p>}</section>
      {summary.fourthFloorRotation && <section className="calendar-day-summary calendar-rotation-detail"><b className="calendar-detail-label">4. PATRO</b><p><strong>Mediační místnost + chodba</strong><span>{summary.fourthFloorRotation.assignment?.workerName ? `Na řadě: ${summary.fourthFloorRotation.assignment.workerName}` : `Pozice ${summary.fourthFloorRotation.slotLabel} zatím není přiřazena`}</span></p></section>}
      {summary.extraCategories.length > 0 && <section className="calendar-day-summary"><b className="calendar-detail-label">DNES NAVÍC</b><div className="calendar-extra-detail">{summary.extraCategories.map((category) => <article key={category.key}><i>{category.symbol}</i><span><b>{category.label}</b><small>{category.taskCount} {category.taskCount === 1 ? "úkol" : category.taskCount < 5 ? "úkoly" : "úkolů"}</small><ul>{category.scopes.map((scope) => <li key={scope}>{scope}</li>)}</ul></span></article>)}</div></section>}
      <p className="calendar-routine-note">Běžný úklid probíhá podle pracovního rozdělení. <button onClick={onOpenAssignments}>Zobrazit rozdělení práce</button></p>
    </section>
  );
}

function CleaningCalendar({
  records,
  available,
  taskSelectionAvailable,
  canManage,
  buildings,
  tasks,
  planning,
  availableWorkers,
  onOpenAssignments,
  onSave,
  onCancel,
}: {
  records: CleaningDayRecord[];
  available: boolean;
  taskSelectionAvailable: boolean;
  canManage: boolean;
  buildings: PlanOptions["buildings"];
  tasks: Task[];
  planning: WorkerPlanningData;
  availableWorkers: AttendanceWorker[];
  onOpenAssignments: () => void;
  onSave: (draft: CleaningDayDraft) => Promise<void>;
  onCancel: (id: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState<CleaningDayRecord | "new" | null>(null);
  const today = localDateKey();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [selectedDate, setSelectedDate] = useState(today);
  const [buildingFilter, setBuildingFilter] = useState("all");
  const [workerFilter, setWorkerFilter] = useState("all");
  const [serverDynamicPlan, setServerDynamicPlan] = useState<Map<string, Set<string>> | null>(null);
  const workerOptions = useMemo(() => {
    const values = new Map(calendarWorkerOptions(planning).map((worker) => [worker.id, worker.name]));
    availableWorkers.forEach((worker) => values.set(worker.id, worker.name));
    return [...values.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "cs"));
  }, [planning, availableWorkers]);
  const planTasks = useMemo(() => tasks.filter((task) => !isFinalCheckTask(task)), [tasks]);
  const visibleRecords = useMemo(
    () => buildingFilter === "all" ? records : records.filter((record) => record.buildingId === buildingFilter),
    [records, buildingFilter],
  );
  const visiblePlanning = useMemo(() => buildingFilter === "all" ? planning : ({
    ...planning,
    assignments: planning.assignments.filter((item) => item.buildingId === buildingFilter),
    exceptions: planning.exceptions.filter((item) => !item.planned || item.buildingId === buildingFilter),
  }), [planning, buildingFilter]);
  const future = records.filter((item) => item.executionDate >= today).sort((a, b) => a.executionDate.localeCompare(b.executionDate));
  const gridDates = useMemo(() => monthGridDates(month), [month]);
  useEffect(() => {
    let active = true;
    if (!gridDates.length) return;
    const gridFrom = gridDates[0];
    const gridTo = gridDates[gridDates.length - 1];
    const outsideSourceDates = [...new Set(records
      .filter((record) => record.status === "active" && record.kind === "rescheduled"
        && record.executionDate >= gridFrom && record.executionDate <= gridTo && record.sourceDate
        && (record.sourceDate < gridFrom || record.sourceDate > gridTo))
      .map((record) => record.sourceDate as string))];
    Promise.all([
      schoolRepository.dynamicSchoolPlan(gridFrom, gridTo),
      ...outsideSourceDates.map((sourceDate) => schoolRepository.dynamicSchoolPlan(sourceDate, sourceDate)),
    ])
      .then((values) => {
        if (!active) return;
        if (values.some((value) => value === null)) {
          setServerDynamicPlan(null);
          return;
        }
        const merged = new Map<string, Set<string>>();
        values.forEach((value) => value?.forEach((ids, date) => {
          const current = merged.get(date) ?? new Set<string>();
          ids.forEach((id) => current.add(id));
          merged.set(date, current);
        }));
        setServerDynamicPlan(merged);
      })
      .catch((error) => { console.error("Dynamický plán kalendáře se nepodařilo načíst:", error); if (active) setServerDynamicPlan(null); });
    return () => { active = false; };
  }, [gridDates, records]);
  const resolvedCalendarDays = useMemo(() => gridDates.map((date) => ({
    date,
    tasks: plannedTasksForDate(planTasks, records, date, serverPlanForCalendarDate(date, records, serverDynamicPlan)),
  })), [gridDates, records, planTasks, planning, serverDynamicPlan]);
  const calendarDays = useMemo(() => resolvedCalendarDays.map((item) => {
    const visibleTasks = filterCalendarTasks(item.tasks, buildingFilter);
    const context = calendarContextForDate(visibleTasks, visibleRecords, item.date);
    return buildCalendarDaySummary({ date: item.date, today, tasks: visibleTasks, context, exceptions: visibleRecords, planning: visiblePlanning, workerId: workerFilter });
  }), [resolvedCalendarDays, buildingFilter, visibleRecords, visiblePlanning, workerFilter, today]);
  const selected = calendarDays.find((item) => item.date === selectedDate)
    ?? (() => {
      const due = filterCalendarTasks(plannedTasksForDate(planTasks, records, selectedDate, serverPlanForCalendarDate(selectedDate, records, serverDynamicPlan)), buildingFilter);
      return buildCalendarDaySummary({ date: selectedDate, today, tasks: due, context: calendarContextForDate(due, visibleRecords, selectedDate), exceptions: visibleRecords, planning: visiblePlanning, workerId: workerFilter });
    })();
  const moveMonth = (amount: number) => {
    const [year, monthNumber] = month.split("-").map(Number);
    const next = new Date(Date.UTC(year, monthNumber - 1 + amount, 1));
    const key = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
    setMonth(key);
    setSelectedDate(`${key}-01`);
  };
  const goToday = () => { setMonth(today.slice(0, 7)); setSelectedDate(today); };
  const monthLabel = new Intl.DateTimeFormat("cs-CZ", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T12:00:00Z`));
  return (
    <div className="cleaning-calendar">
      <section className="panel calendar-intro">
        <p className="eyebrow">KALENDÁŘ ÚKLIDU</p>
        <b>Kdo je v práci a co se dělá navíc.</b>
        <small>Plán se automaticky přepočítá podle skutečně naplánovaných pracovníků. Rutinní mikroúkoly kalendář nezaplňují.</small>
      </section>
      {!planning.available && <div className="notice">Pracovní rozdělení se zobrazí po zkontrolování a aplikaci migrace 03100. Práce navíc zůstává dostupná.</div>}
      <div className="calendar-filter" role="group" aria-label="Filtrovat pracoviště"><button className={buildingFilter === "all" ? "active" : ""} onClick={() => setBuildingFilter("all")}>Vše</button>{buildings.map((building) => <button className={buildingFilter === building.id ? "active" : ""} key={building.id} onClick={() => setBuildingFilter(building.id)}>{building.name}</button>)}</div>
      <label className="calendar-worker-filter">Pracovník<select value={workerFilter} onChange={(event) => setWorkerFilter(event.target.value)}><option value="all">Všichni</option>{workerOptions.map((worker) => <option key={worker.id} value={worker.id}>{worker.name}</option>)}</select></label>
      {!available && (
        <div className="notice">Správa skutečných mimořádných a přesunutých dnů bude dostupná po zkontrolování a aplikaci migrace 01300.</div>
      )}
      {available && canManage && !editing && <button className="primary-action" onClick={() => setEditing("new")}>+ Přidat úklidový den</button>}
      {available && editing && (
        <CleaningDayEditor
          record={editing === "new" ? undefined : editing}
          buildings={buildings}
          tasks={tasks}
          taskSelectionAvailable={taskSelectionAvailable}
          onCancel={() => setEditing(null)}
          onSave={async (draft) => { await onSave(draft); setEditing(null); }}
        />
      )}
      <section className="month-calendar" aria-label="Měsíční plán úklidu">
        <header className="calendar-month-nav"><button onClick={() => moveMonth(-1)} aria-label="Předchozí měsíc">‹</button><span><h2>{monthLabel}</h2><button className="calendar-today-button" onClick={goToday}>Dnes</button></span><button onClick={() => moveMonth(1)} aria-label="Další měsíc">›</button></header>
        <div className="calendar-weekdays">{weekdays.map((day) => <b key={day}>{day}</b>)}</div>
        <div className="calendar-grid">
          {calendarDays.map((item) => <CalendarDayCell key={item.date} summary={item} month={month} selected={item.date === selectedDate} onSelect={(date, outside) => { setSelectedDate(date); if (outside) setMonth(date.slice(0, 7)); }} />)}
        </div>
        <CalendarLegend />
      </section>
      <CalendarDayDetail summary={selected} onOpenAssignments={onOpenAssignments} />
      <section className="calendar-list">
        <h2>Plánované výjimky</h2>
        {future.map((item) => (
          <article key={item.id} className={item.status === "cancelled" ? "cancelled" : ""}>
            <div>
              <small>{item.kind === "extraordinary" ? "MIMOŘÁDNÝ ÚKLID" : "PŘESUNUTÝ ÚKLID"}</small>
              <b>{item.title}</b>
              <span>{buildings.find((building) => building.id === item.buildingId)?.name ?? "Pracoviště"}</span>
              <span>{formatDate(item.executionDate)}{item.sourceDate ? ` · původně ${formatDate(item.sourceDate)}` : ""}</span>
              {item.note && <p>{item.note}</p>}
            </div>
            {canManage && item.status === "active" && (
              <div className="calendar-actions">
                <button onClick={() => setEditing(item)}>
                  {item.kind === "extraordinary" ? "Upravit úklid" : "Upravit přesun"}
                </button>
                <button className="danger-link" onClick={() => { if (window.confirm("Opravdu chcete tento úklidový den zrušit?")) void onCancel(item.id); }}>Zrušit</button>
              </div>
            )}
            {item.status === "cancelled" && <strong>Zrušeno</strong>}
          </article>
        ))}
        {available && !future.length && <p className="hint">Nejsou naplánované žádné budoucí výjimky.</p>}
      </section>
    </div>
  );
}

function isExtraordinaryBaselineTask(task: Task, date: string) {
  if (!task.active || task.activityType === "other" && task.frequency === "mimořádně") return false;
  if (task.frequency === "denně") return true;
  if (task.frequency === "měsíčně") return task.monthlyDay === Number(date.slice(8, 10));
  if (task.frequency === "mimořádně") return false;
  const day = new Date(`${date}T12:00:00`).getDay() || 7;
  return task.scheduleDays.includes(day);
}

function selectedTasksForExtraordinaryDay(
  tasks: Task[],
  date: string,
  overrides: Record<string, boolean> = {},
) {
  return new Set(
    tasks
      .filter((task) => task.active && task.roomActive !== false)
      .filter((task) => overrides[task.id] ?? isExtraordinaryBaselineTask(task, date))
      .map((task) => task.id),
  );
}

function ExtraordinaryTaskSelector({
  tasks,
  executionDate,
  selected,
  onChange,
}: {
  tasks: Task[];
  executionDate: string;
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const eligible = tasks.filter((task) => task.active && task.roomActive !== false);
  const common = eligible.filter((task) => !task.roomId);
  const floors = new Map<string, Task[]>();
  eligible.filter((task) => task.roomId).forEach((task) => {
    floors.set(task.floor, [...(floors.get(task.floor) ?? []), task]);
  });
  const toggle = (task: Task, checked: boolean) => {
    const next = new Set(selected);
    if (checked) {
      let current: Task | undefined = task;
      const visited = new Set<string>();
      while (current && !visited.has(current.id)) {
        visited.add(current.id);
        next.add(current.id);
        current = current.prerequisite
          ? eligible.find((item) => item.id === current?.prerequisite)
          : undefined;
      }
    } else {
      next.delete(task.id);
      let changed = true;
      while (changed) {
        changed = false;
        for (const dependent of eligible) {
          if (dependent.prerequisite && !next.has(dependent.prerequisite) && next.delete(dependent.id)) {
            changed = true;
          }
        }
      }
    }
    onChange(next);
  };
  const renderTasks = (roomTasks: Task[]) => (
    <div className="exception-task-list">
      {[...roomTasks].sort((a, b) => a.sortOrder - b.sortOrder).map((task) => {
        const checked = selected.has(task.id);
        const baseline = isExtraordinaryBaselineTask(task, executionDate);
        return (
          <label className="exception-task" key={task.id}>
            <input
              type="checkbox"
              checked={checked}
              disabled={task.done && checked}
              onChange={(event) => toggle(task, event.target.checked)}
            />
            <span aria-hidden="true">{activityTypes[task.activityType]?.icon ?? "✓"}</span>
            <span>
              <b>{task.title}</b>
              <small>
                {baseline ? "Běžný kompletní plán" : formatTaskSchedule(task)}
                {task.prerequisite ? " · vyžaduje předchozí činnost" : ""}
                {task.done ? " · již hotovo" : ""}
              </small>
            </span>
          </label>
        );
      })}
    </div>
  );
  return (
    <fieldset className="exception-task-picker">
      <legend>Činnosti tohoto mimořádného úklidu</legend>
      <p className="hint">
        Běžný kompletní plán je předvybraný. Další činnost lze přidat jen pro
        tento den; její pravidelná frekvence se nezmění.
      </p>
      <strong>{selected.size} vybraných činností</strong>
      {[...floors.entries()]
        .sort(([, a], [, b]) => a[0].floorSort - b[0].floorSort)
        .map(([floor, floorTasks]) => {
          const rooms = new Map<string, Task[]>();
          floorTasks.forEach((task) => rooms.set(task.room, [...(rooms.get(task.room) ?? []), task]));
          return (
            <details className="exception-floor" key={floor}>
              <summary><b>{floor}</b><span>{floorTasks.filter((task) => selected.has(task.id)).length}/{floorTasks.length}</span></summary>
              {[...rooms.entries()].map(([room, roomTasks]) => (
                <details className="exception-room" key={room}>
                  <summary><b>{room}</b><span>{roomTasks.filter((task) => selected.has(task.id)).length}/{roomTasks.length}</span></summary>
                  {renderTasks(roomTasks)}
                </details>
              ))}
            </details>
          );
        })}
      {common.length > 0 && (
        <details className="exception-floor">
          <summary><b>Společné úkoly</b><span>{common.filter((task) => selected.has(task.id)).length}/{common.length}</span></summary>
          {renderTasks(common)}
        </details>
      )}
    </fieldset>
  );
}

function CleaningDayEditor({
  record,
  buildings,
  tasks,
  taskSelectionAvailable,
  onCancel,
  onSave,
}: {
  record?: CleaningDayRecord;
  buildings: PlanOptions["buildings"];
  tasks: Task[];
  taskSelectionAvailable: boolean;
  onCancel: () => void;
  onSave: (draft: CleaningDayDraft) => Promise<void>;
}) {
  const [buildingId, setBuildingId] = useState(record?.buildingId ?? "");
  const workplaceTasks = tasks.filter((task) => !task.buildingId || task.buildingId === buildingId);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const [kind, setKind] = useState<"extraordinary" | "rescheduled">(record?.kind ?? "extraordinary");
  const [executionDate, setExecutionDate] = useState(record?.executionDate ?? localDateKey(tomorrow));
  const [sourceDate, setSourceDate] = useState(record?.sourceDate ?? localDateKey());
  const [title, setTitle] = useState(record?.title ?? "");
  const [note, setNote] = useState(record?.note ?? "");
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(
    () => selectedTasksForExtraordinaryDay(workplaceTasks, record?.executionDate ?? localDateKey(tomorrow), record?.taskOverrides),
  );
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (kind !== "extraordinary") return;
    setSelectedTaskIds(selectedTasksForExtraordinaryDay(workplaceTasks, executionDate, record?.taskOverrides));
  }, [kind, executionDate, record?.id, record?.taskOverrides, tasks, buildingId]);
  return (
    <form className="task-editor cleaning-day-editor" onSubmit={async (event) => {
      event.preventDefault();
      setSaving(true);
      try {
        await onSave({
          id: record?.id,
          buildingId,
          kind,
          executionDate,
          sourceDate: kind === "rescheduled" ? sourceDate : null,
          title,
          note,
          selectedTaskIds: kind === "extraordinary" && taskSelectionAvailable
            ? [...selectedTaskIds]
            : undefined,
        });
      } finally { setSaving(false); }
    }}>
      <h2>{record ? "Upravit úklidový den" : "Nový úklidový den"}</h2>
      <label>Pracoviště<select value={buildingId} onChange={(event) => setBuildingId(event.target.value)} required disabled={Boolean(record)}><option value="">Vyberte pracoviště</option>{buildings.map((building) => <option key={building.id} value={building.id}>{building.name}</option>)}</select></label>
      <fieldset><legend>Typ</legend>
        <label className="radio"><input type="radio" checked={kind === "extraordinary"} onChange={() => setKind("extraordinary")} /> Mimořádný úklid</label>
        <label className="radio"><input type="radio" checked={kind === "rescheduled"} onChange={() => setKind("rescheduled")} /> Přesun pravidelného úklidu</label>
      </fieldset>
      {kind === "rescheduled" && <label>Původní datum<input type="date" min={localDateKey()} value={sourceDate ?? ""} onChange={(event) => setSourceDate(event.target.value)} required /></label>}
      <label>{kind === "rescheduled" ? "Nový termín" : "Datum"}<input type="date" value={executionDate} min={localDateKey()} onChange={(event) => setExecutionDate(event.target.value)} required /></label>
      <label>Název<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={kind === "extraordinary" ? "Generální úklid" : "Přesun kvůli školní akci"} required /></label>
      <label>Rozsah<input value="Celá škola · běžný kompletní úklid" readOnly /></label>
      {kind === "extraordinary" && taskSelectionAvailable && (
        <ExtraordinaryTaskSelector
          tasks={workplaceTasks}
          executionDate={executionDate}
          selected={selectedTaskIds}
          onChange={setSelectedTaskIds}
        />
      )}
      {kind === "extraordinary" && !taskSelectionAvailable && (
        <div className="notice">
          Konkrétní činnosti bude možné upravit po zkontrolování a aplikaci migrace 01400.
        </div>
      )}
      <label>Poznámka<textarea value={note ?? ""} onChange={(event) => setNote(event.target.value)} rows={3} /></label>
      <div className="editor-actions"><button type="button" onClick={onCancel}>Zrušit</button><button disabled={saving}>{saving ? "Ukládám…" : "Uložit"}</button></div>
    </form>
  );
}

function AccessStateScreen({
  title,
  text,
  onSignOut,
}: {
  title: string;
  text: string;
  onSignOut: () => Promise<void>;
}) {
  return (
    <main className="app">
      <section className="panel login access-state">
        <p className="eyebrow">ÚKLID ŠKOLY</p>
        <h1>{title}</h1>
        <p>{text}</p>
        <button type="button" onClick={() => void onSignOut()}>
          Odhlásit se
        </button>
      </section>
    </main>
  );
}

function SetupScreen() {
  return (
    <main className="app">
      <section className="empty">
        <span>⚙</span>
        <h1>Dokončete propojení</h1>
        <p>
          Do souboru <code>.env.local</code> vložte veřejnou adresu projektu
          Supabase a anon klíč podle <code>.env.example</code>. Poté aplikaci
          restartujte.
        </p>
      </section>
    </main>
  );
}
function LoginScreen({
  notice,
  onLoginWithGoogle,
}: {
  notice: string;
  onLoginWithGoogle: () => Promise<void>;
}) {
  return (
    <main className="app">
      <section className="panel login">
        <p className="eyebrow">ÚKLID ŠKOLY</p>
        <h1>Přihlášení</h1>
        <p className="hint">
          Přihlaste se školním účtem. Zobrazí se pouze data podle vašich
          oprávnění.
        </p>
        {notice && <div className="notice">{notice}</div>}
        <button type="button" onClick={() => void onLoginWithGoogle()}>
          Pokračovat přes Google
        </button>
      </section>
    </main>
  );
}
