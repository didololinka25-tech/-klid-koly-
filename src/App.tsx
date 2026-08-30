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
  type AttendanceWorker,
  type AppSettings,
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
  type Workplace,
} from "./schoolRepository";
import {
  buildAttendanceReport,
  downloadAttendanceReportPdf,
  reportDuration,
} from "./attendanceReport";
import { isSupabaseConfigured } from "./supabase";
import { isTaskDueForCleaningDay, monthGridDates, resolveCleaningDay, type CleaningDayContext } from "./scheduling";
import type { ActivityType, Attendance, Frequency, Task } from "./types";
import { attendanceEditorStartValue, pragueDateKey, pragueDateTimeInput } from "./attendanceTime";

type Section =
  | "Dnes"
  | "Docházka"
  | "Kalendář"
  | "Provoz"
  | "Více"
  | "Manuál"
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
const finalCheckPrefix = "v2026|school|common|final-";
const isFinalCheckTask = (task: Task) => Boolean(task.planKey?.startsWith(finalCheckPrefix) || task.planKey?.startsWith("admin|final|"));
const todayLabel = new Intl.DateTimeFormat("cs-CZ", {
  weekday: "long",
  day: "numeric",
  month: "long",
}).format(new Date());

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
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
  const [operations, setOperations] = useState<OperationsData>({ stock: [], incidents: [], rooms: [], editable: false });
  const [manual, setManual] = useState<ManualData>({ entries: [], available: false, editable: false });
  const [attendance, setAttendance] = useState<Attendance[]>([]);
  const [attendanceView, setAttendanceView] = useState<Attendance[]>([]);
  const [attendanceWorkers, setAttendanceWorkers] = useState<AttendanceWorker[]>([]);
  const [selectedAttendanceWorker, setSelectedAttendanceWorker] = useState("");
  const [attendanceSettings, setAttendanceSettings] = useState<AttendanceSettings>({
    plannedShiftsPerWeek: 3,
    configurable: false,
  });
  const [appSettings, setAppSettings] = useState<AppSettings>({
    dppAnnualLimitHours: 300,
    available: false,
  });
  const [workplaces, setWorkplaces] = useState<Workplace[]>([]);
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
  const load = useCallback(
    async (current: Session, knownProfile?: Profile | null) => {
      const activeProfile =
        knownProfile ?? (await schoolRepository.profile(current.user.id));
      if (!activeProfile) {
        setNotice("Profil se zatím nepodařilo načíst.");
        return;
      }
      setProfile(activeProfile);
      if (!activeProfile.active || !canViewSchool(activeProfile)) {
        setTasks([]);
        setAttendance([]);
        setAttendanceView([]);
        setAttendanceWorkers([]);
        setUsers([]);
        setWorkplaces([]);
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
          : { dppAnnualLimitHours: 300, available: false },
      );
      const taskResult = await Promise.resolve(
        schoolRepository.tasks(activeProfile, canManageOperations(activeProfile)),
      ).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason) => ({ status: "rejected" as const, reason }),
      );
      if (taskResult.status === "fulfilled") {
        setTasks(taskResult.value.tasks);
        setCleaningDay(taskResult.value.cleaningDay);
        setCleaningDaysAvailable(taskResult.value.cleaningDaysAvailable);
      } else {
        setTasks([]);
        setNotice(
          taskResult.reason instanceof Error
            ? taskResult.reason.message
            : "Úkoly se nepodařilo načíst.",
        );
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
      const [daysResult, operationsResult, manualResult] = await Promise.allSettled([
        schoolRepository.cleaningDays(),
        schoolRepository.operations(),
        schoolRepository.manuals(activeProfile),
      ]);
      if (daysResult.status === "fulfilled") {
        setCleaningDays(daysResult.value.records);
        setCleaningDaysAvailable(daysResult.value.available);
        setCleaningTaskSelectionAvailable(daysResult.value.taskSelectionAvailable);
      }
      if (operationsResult.status === "fulfilled") setOperations(operationsResult.value);
      if (manualResult.status === "fulfilled") setManual(manualResult.value);
    },
    [],
  );
  useEffect(() => {
    if (!isSupabaseConfigured) return;
    schoolRepository.getSession().then((next) => {
      setSession(next);
      if (next) load(next).catch((error) => setNotice(error.message));
    });
    const { data } = schoolRepository.onAuthChange((next) => {
      setSession(next);
      setProfile(null);
      setTasks([]);
      setUsers([]);
      setCleaningDays([]);
      setCleaningTaskSelectionAvailable(false);
      setAttendance([]);
      setAttendanceView([]);
      setAttendanceWorkers([]);
      setSelectedAttendanceWorker("");
      setWorkplaces([]);
      setManual({ entries: [], available: false, editable: false });
      setAttendanceBuildingId("");
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
    ])
      .then(([records, settings]) => {
        setAttendanceView(records);
        setAttendanceSettings(settings);
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
      setTasks((current) => current.map((task) => task.id === id ? { ...task, done: !target.done } : task));
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
    const selectedIds = selectedTasks.map((task) => task.id);
    if (
      selectedTasks.some((task) => !task.canComplete) ||
      selectedIds.some((id) => taskWriteLocks.current.has(id))
    )
      return;
    selectedIds.forEach((id) => taskWriteLocks.current.add(id));
    setPendingTaskIds(new Set(taskWriteLocks.current));
    const remaining = new Map(
      selectedTasks.filter((task) => !task.done).map((task) => [task.id, task]),
    );
    const orderedIds: string[] = [];
    try {
      setNotice("");
      for (const task of remaining.values()) {
        if (
          task.prerequisite &&
          !tasks.find((item) => item.id === task.prerequisite)?.done &&
          !remaining.has(task.prerequisite)
        ) {
          throw new Error(
            `Nejdříve dokončete předchozí činnost pro „${task.title}“.`,
          );
        }
      }
      while (remaining.size > 0) {
        const ready = [...remaining.values()]
          .filter(
            (task) =>
              !task.prerequisite ||
              tasks.find((item) => item.id === task.prerequisite)?.done ||
              !remaining.has(task.prerequisite),
          )
          .sort((a, b) => a.sortOrder - b.sortOrder);
        if (ready.length === 0) {
          throw new Error("Úkoly mají neplatnou kruhovou závislost.");
        }
        for (const task of ready) {
          orderedIds.push(task.id);
          remaining.delete(task.id);
        }
      }
      await schoolRepository.setCompletions(orderedIds);
      const completedIds = new Set(orderedIds);
      setTasks((current) => current.map((task) => completedIds.has(task.id) ? { ...task, done: true } : task));
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
      setProfileEditorOpen(false);
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
  const visible =
    section === "Dnes"
      ? tasks.filter((task) => task.active && task.dueToday)
      : tasks;
  const visibleDone = visible.filter((task) => task.done).length;
  const navigation = sections.filter((item) => {
    if (item === "Docházka") return canWork(profile);
    return true;
  });
  return (
    <main className="app">
      <header>
        <div>
          <p className="eyebrow">ÚKLID ŠKOLY · ŠKOLA</p>
          <h1>{section}</h1>
          <p className="date">{todayLabel}</p>
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
          <section className={visible.length > 0 && visibleDone === visible.length ? "hero cleaning-complete" : "hero"}>
            <span className="hero-copy">
              <b>{cleaningDayHeading(cleaningDay, visible.length)}</b>
              <small>{cleaningDayDescription(cleaningDay)}</small>
            </span>
            <strong>
              {visibleDone} / {visible.length} hotovo
            </strong>
            <ProgressBar value={visibleDone} total={visible.length} label="Celkový průběh úklidu" />
            {visible.length > 0 && visibleDone === visible.length && <p>Všechno hotovo – můžete odejít.</p>}
          </section>
          {cleaningDay.kind !== "preview" && visible.length > 0 && (
            <ArrivalReminders entries={manual.entries.filter((entry) => entry.entryType === "arrival" && entry.active)} />
          )}
          {accessRole(profile) === "visitor" && (
            <p className="readonly-note">Návštěvnický přístup je pouze pro čtení.</p>
          )}
          <TaskHierarchy
            tasks={visible}
            onComplete={complete}
            onCompleteAll={completeMany}
            pendingTaskIds={pendingTaskIds}
            guides={manual.entries.filter((entry) => entry.entryType === "guide" && entry.active)}
          />
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
        />
      )}
      {section === "Kalendář" && (
        <CleaningCalendar
          records={cleaningDays}
          available={cleaningDaysAvailable}
          taskSelectionAvailable={cleaningTaskSelectionAvailable}
          canManage={canManageOperations(profile)}
          buildingId={planOptions.buildings.find((item) => item.name === "Škola")?.id ?? ""}
          tasks={tasks}
          onSave={saveCleaningDay}
          onCancel={cancelCleaningDay}
        />
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
          onOpenManual={() => setSection("Manuál")}
          workplaces={workplaces}
          appSettings={appSettings}
          onSaveWorkplace={saveWorkplace}
          onSaveDppLimit={saveDppLimit}
        />
      )}
      {profileEditorOpen && (
        <ProfileEditor
          profile={profile}
          editable={appSettings.available}
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
            <span>Pracoviště: {open.buildingName}</span>
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
          Pracoviště
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
}: {
  records: Attendance[];
  workers: AttendanceWorker[];
  selectedWorkerId: string;
  onSelectWorker: (id: string) => void;
  settings: AttendanceSettings;
  dppAnnualLimitHours: number;
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
  const progress = Math.min(
    100,
    (metrics.yearHours / dppAnnualLimitHours) * 100,
  );
  const selectedName =
    workers.find((worker) => worker.id === selectedWorkerId)?.name ?? "Pracovník";
  const yearWarning =
    metrics.yearHours >= dppAnnualLimitHours
      ? "Roční limit DPP vyčerpán. Evidence dále zaznamenává skutečnou práci."
      : metrics.yearHours >= dppAnnualLimitHours * (280 / 300)
        ? "Pozor, roční fond DPP je téměř vyčerpán."
        : metrics.yearHours >= dppAnnualLimitHours * (250 / 300)
          ? `Roční fond DPP se blíží limitu ${dppAnnualLimitHours} hodin.`
          : "";
  const weeklyDifference =
    metrics.weekMs / HOUR_MS - metrics.recommendedWeeklyHours;
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
          <span>
            plán {formatDuration(metrics.recommendedWeeklyHours * HOUR_MS)}
          </span>
        </article>
        <article>
          <small>TENTO MĚSÍC</small>
          <strong>{formatDuration(metrics.monthMs)}</strong>
        </article>
        <article>
          <small>ROK – DPP</small>
          <strong>
            {metrics.yearHours.toFixed(1)} / {dppAnnualLimitHours} h
          </strong>
          <span>Zbývá {metrics.remainingHours.toFixed(1)} h</span>
        </article>
      </div>
      <div className="dpp-progress" aria-label="Čerpání ročního limitu DPP">
        <span style={{ width: `${progress}%` }} />
      </div>
      {yearWarning && (
        <div
          className={`attendance-alert ${metrics.yearHours >= dppAnnualLimitHours * (280 / 300) ? "danger" : ""}`}
        >
          {yearWarning}
        </div>
      )}
      <section className="pace-card">
        <p className="eyebrow">DOPORUČENÉ TEMPO</p>
        <strong>
          Průměr do konce roku: cca {metrics.recommendedWeeklyHours.toFixed(1)} h
          týdně
        </strong>
        <p>
          Zbývá {metrics.remainingHours.toFixed(1)} h a přibližně {metrics.weeksRemaining}{" "}
          plánovatelných týdnů do 31. 12.
        </p>
        <p>
          Při {settings.plannedShiftsPerWeek} směnách týdně: cca{" "}
          {metrics.recommendedShiftHours.toFixed(1)} h / směnu.
        </p>
        <b>Zákonné maximum jedné směny: 12 h.</b>
        <small>
          Jde o rovnoměrné plánovací tempo, nikoli o zákonné týdenní maximum.
        </small>
        <div className="shift-setting">
          <label>
            Směn týdně
            <input
              type="number"
              min="1"
              max="7"
              value={plannedShifts}
              onChange={(event) => setPlannedShifts(Number(event.target.value))}
              disabled={!settings.configurable}
            />
          </label>
          <button
            onClick={() => void onSaveSettings(plannedShifts)}
            disabled={!settings.configurable}
          >
            Uložit
          </button>
        </div>
        {!settings.configurable && (
          <small>Nastavení bude dostupné po aplikaci připravené migrace.</small>
        )}
      </section>
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
          <span>
            Doporučené tempo{" "}
            <b>{formatClockDuration(metrics.recommendedWeeklyHours * HOUR_MS)}</b>
          </span>
          <p>
            {weeklyDifference > 0
              ? `Tento týden jsi o ${formatDuration(weeklyDifference * HOUR_MS)} nad rovnoměrným tempem.`
              : `Do doporučeného tempa zbývá ${formatDuration(-weeklyDifference * HOUR_MS)}.`}
          </p>
        </footer>
      </section>
      <MonthlyAttendanceReport
        records={records}
        now={now}
        workerName={selectedName}
        dppAnnualLimitHours={dppAnnualLimitHours}
      />
      <AttendanceHistory
        records={records}
        now={now}
        onEdit={setEditingRecord}
        onDelete={setDeletingRecord}
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

function MonthlyAttendanceReport({
  records,
  now,
  workerName,
  dppAnnualLimitHours,
}: {
  records: Attendance[];
  now: Date;
  workerName: string;
  dppAnnualLimitHours: number;
}) {
  const [month, setMonth] = useState(localDateKey(now).slice(0, 7));
  const [preview, setPreview] = useState(false);
  const report = useMemo(
    () =>
      buildAttendanceReport(
        records,
        workerName,
        month,
        dppAnnualLimitHours,
        now,
      ),
    [records, workerName, month, dppAnnualLimitHours, now],
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
        <span className="report-dpp">DPP <b>{reportDuration(report.yearMs)} / {dppAnnualLimitHours} h</b></span>
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
        <span>Typ: DPP</span>
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
        <b>DPP: {reportDuration(report.yearMs)} / {report.annualLimitHours} h</b>
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
}: {
  records: Attendance[];
  now: Date;
  onEdit: (record: Attendance) => void;
  onDelete: (record: Attendance) => void;
}) {
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
                <button className="delete" onClick={() => onDelete(record)}>
                  Smazat
                </button>
              </div>
            </article>
          ))}
        </details>
      ))}
      {!records.length && <p className="hint">Zatím nejsou evidované žádné směny.</p>}
    </section>
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
  onComplete,
  onCompleteAll,
  pendingTaskIds,
  guides,
}: {
  tasks: Task[];
  onComplete: (id: string) => Promise<void>;
  onCompleteAll: (tasks: Task[]) => Promise<void>;
  pendingTaskIds: Set<string>;
  guides: ManualEntry[];
}) {
  const finalChecks = tasks.filter(isFinalCheckTask);
  const common = tasks.filter((task) => !task.roomId && !isFinalCheckTask(task));
  const roomTasks = tasks.filter((task) => task.roomId && !isFinalCheckTask(task));
  const floorGroups = new Map<string, Task[]>();
  roomTasks
    .forEach((task) =>
      floorGroups.set(`${task.building}|${task.floor}`, [
        ...(floorGroups.get(`${task.building}|${task.floor}`) ?? []),
        task,
      ]),
    );
  return (
    <>
      {common.length > 0 && (
        <section className="shared-tasks">
          <h2>Společné úkoly</h2>
          <TaskRows
            tasks={common}
            onComplete={onComplete}
            pendingTaskIds={pendingTaskIds}
            guides={guides}
          />
        </section>
      )}
      {[...floorGroups.entries()]
        .sort(([, a], [, b]) => a[0].floorSort - b[0].floorSort)
        .map(([key, floorTasks]) => (
          <FloorGroup
            key={key}
            label={key.split("|")[1]}
            tasks={floorTasks}
            onComplete={onComplete}
            onCompleteAll={onCompleteAll}
            pendingTaskIds={pendingTaskIds}
            guides={guides}
          />
        ))}
      {finalChecks.length > 0 && (
        <section className="shared-tasks final-checks">
          <div className="section-heading">
            <span><h2>Před odchodem ze školy</h2><small>Povinná společná kontrola</small></span>
            <b>{finalChecks.filter((task) => task.done).length}/{finalChecks.length}</b>
          </div>
          <TaskRows tasks={finalChecks} onComplete={onComplete} pendingTaskIds={pendingTaskIds} allTasks={tasks} guides={guides} />
        </section>
      )}
      {tasks.length === 0 && (
        <section className="empty">
          <span>✓</span>
          <h2>Pro tento den nejsou naplánované úkoly.</h2>
        </section>
      )}
    </>
  );
}
function FloorGroup({
  label,
  tasks,
  onComplete,
  onCompleteAll,
  pendingTaskIds,
  guides,
}: {
  label: string;
  tasks: Task[];
  onComplete: (id: string) => Promise<void>;
  onCompleteAll: (tasks: Task[]) => Promise<void>;
  pendingTaskIds: Set<string>;
  guides: ManualEntry[];
}) {
  const [open, setOpen] = useState(true);
  const rooms = new Map<string, Task[]>();
  tasks.forEach((task) =>
    rooms.set(task.room, [...(rooms.get(task.room) ?? []), task]),
  );
  const complete = tasks.filter((task) => task.done).length;
  return (
    <section className="floor-group">
      <button
        className="floor-toggle"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span>
          <b>{label}</b>
          <small>
            {complete} / {tasks.length} hotovo
          </small>
        </span>
        <i>{open ? "⌃" : "⌄"}</i>
        <ProgressBar value={complete} total={tasks.length} label={`Průběh: ${label}`} />
      </button>
      {open && (
        <div className="room-list">
          {[...rooms.entries()].map(([room, roomTasks]) => (
            <RoomActivityGroup
              key={room}
              room={room}
              tasks={roomTasks}
              onComplete={onComplete}
              onCompleteAll={onCompleteAll}
              pendingTaskIds={pendingTaskIds}
              guides={guides}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function RoomActivityGroup({
  room,
  tasks,
  onComplete,
  onCompleteAll,
  pendingTaskIds,
  guides,
}: {
  room: string;
  tasks: Task[];
  onComplete: (id: string) => Promise<void>;
  onCompleteAll: (tasks: Task[]) => Promise<void>;
  pendingTaskIds: Set<string>;
  guides: ManualEntry[];
}) {
  const [saving, setSaving] = useState(false);
  const completed = tasks.filter((task) => task.done).length;
  return (
    <section className="room-group">
      <header className="room-heading">
        <span>
          <h3>{room}</h3>
          <small>
            {completed}/{tasks.length}
          </small>
        </span>
        <button
          className="complete-room"
          disabled={
            saving ||
            completed === tasks.length ||
            tasks.some((task) => !task.canComplete)
          }
          onClick={async () => {
            setSaving(true);
            try {
              await onCompleteAll(tasks);
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? "Ukládám…" : "Hotovo vše"}
        </button>
      </header>
      <TaskRows
        tasks={tasks}
        onComplete={onComplete}
        pendingTaskIds={pendingTaskIds}
        allTasks={tasks}
        guides={guides}
      />
    </section>
  );
}

function TaskRows({
  tasks,
  onComplete,
  pendingTaskIds,
  allTasks = tasks,
  guides = [],
}: {
  tasks: Task[];
  onComplete: (id: string) => Promise<void>;
  pendingTaskIds: Set<string>;
  allTasks?: Task[];
  guides?: ManualEntry[];
}) {
  const [openGuide, setOpenGuide] = useState<ManualEntry | null>(null);
  return (
    <div className="activity-grid">
      {[...tasks]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((task) => {
          const activity = activityTypes[task.activityType] ?? activityTypes.other;
          const blocked = Boolean(task.prerequisite && !allTasks.find((item) => item.id === task.prerequisite)?.done);
          const pending = pendingTaskIds.has(task.id);
          const guide = guides.find((item) => item.activityTypes.includes(task.activityType));
          return (
            <article className={`activity-card${task.done ? " done" : ""}${blocked ? " blocked" : ""}`} key={task.id}>
              <button className="activity-check" disabled={!task.canComplete || pending} onClick={() => void onComplete(task.id)} aria-pressed={task.done} aria-label={`${task.done ? "Zrušit dokončení" : "Dokončit"}: ${task.title}`} title={`${task.title}${task.prerequisite ? " – nejdříve zamést nebo vysát" : ""}`}>
                <span className="activity-icon" aria-hidden="true">{pending ? "…" : task.done ? "✓" : blocked ? "🔒" : activity.icon}</span>
                <span className="activity-copy"><b>{task.title}</b><small>{pending ? "Ukládám…" : blocked ? "Nejdříve předchozí činnost" : task.done ? "Hotovo" : activity.label}</small></span>
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
  return (
    <>
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
          tasks={tasks}
          options={options}
          editing={editing}
          onEdit={onEdit}
          onCancel={onCancel}
          onSave={onSaveTask}
          onSetActive={onSetTaskActive}
        />
      ) : (
        <RoomManager options={options} tasks={tasks} onSave={onSaveRoom} onSaveFloor={onSaveFloor} onSetActive={onSetRoomActive} />
      )}
    </>
  );
}

function PlanManager({
  tasks,
  options,
  editing,
  onEdit,
  onCancel,
  onSave,
  onSetActive,
}: {
  tasks: Task[];
  options: PlanOptions;
  editing: Task | null;
  onEdit: (task: Task) => void;
  onCancel: () => void;
  onSave: (task: Task) => Promise<void>;
  onSetActive: (taskId: string, active: boolean) => Promise<void>;
}) {
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
      active: true,
    });
  const floors = [...options.floors].sort((a, b) => a.sortOrder - b.sortOrder);
  const commonTasks = tasks.filter((task) => !task.roomId && task.active);
  const inactiveTasks = tasks.filter((task) => !task.active);
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
                  <summary><b>{floor.name}</b><span>{floorTaskCount} úkolů</span></summary>
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
                <button className="add-task compact" onClick={() => addTask()}>+ Přidat společný úkol</button>
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
  options,
  tasks,
  onSave,
  onSaveFloor,
  onSetActive,
}: {
  options: PlanOptions;
  tasks: Task[];
  onSave: (room: ManagedRoom) => Promise<void>;
  onSaveFloor: (floor: ManagedFloor) => Promise<void>;
  onSetActive: (roomId: string, active: boolean) => Promise<void>;
}) {
  const school =
    options.buildings.find((building) => building.name === "Škola") ??
    options.buildings[0];
  const schoolFloors = options.floors
    .filter((floor) => !school || floor.buildingId === school.id)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const [editingRoom, setEditingRoom] = useState<ManagedRoom | null>(null);
  const [editingFloor, setEditingFloor] = useState<ManagedFloor | null>(null);
  const inactiveRooms = options.rooms.filter((room) => !room.active);
  const addRoom = (floorId: string) => {
    const floor = schoolFloors.find((item) => item.id === floorId);
    if (!floor || !school) return;
    const floorRooms = options.rooms.filter((room) => room.floorId === floor.id);
    setEditingRoom({
      id: "",
      buildingId: school.id,
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
          {school && <button className="add-task" onClick={() => setEditingFloor({ id: "", buildingId: school.id, name: "", sortOrder: Math.max(0, ...schoolFloors.map((floor) => floor.sortOrder)) + 10 })}>+ Přidat patro / sekci</button>}
          <div className="admin-tree">
            {schoolFloors.map((floor) => {
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
          <option value="">Společný úkol pro školu</option>
          {options.rooms.filter((room) => room.active || room.id === draft.roomId).map((room) => (
            <option key={room.id} value={room.id}>
              {room.floor} · {room.name}
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

function MoreScreen({
  profile,
  pendingCount,
  onOpenPlan,
  onOpenRooms,
  onOpenUsers,
  onOpenCleaningDays,
  onOpenManual,
  workplaces,
  appSettings,
  onSaveWorkplace,
  onSaveDppLimit,
}: {
  profile: Profile;
  pendingCount: number;
  onOpenPlan: () => void;
  onOpenRooms: () => void;
  onOpenUsers: () => Promise<void>;
  onOpenCleaningDays: () => void;
  onOpenManual: () => void;
  workplaces: Workplace[];
  appSettings: AppSettings;
  onSaveWorkplace: (workplace: Workplace) => Promise<void>;
  onSaveDppLimit: (value: number) => Promise<void>;
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
        <p className="hint">Přihlášen: {profile.full_name} · {roleLabel(accessRole(profile))}</p>
      </section>
    </div>
  );
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
  editable,
  onCancel,
  onSave,
}: {
  profile: Profile;
  editable: boolean;
  onCancel: () => void;
  onSave: (fullName: string) => Promise<void>;
}) {
  const [fullName, setFullName] = useState(profile.full_name);
  const [saving, setSaving] = useState(false);
  return (
    <div className="confirmation-backdrop" role="dialog" aria-modal="true" aria-label="Upravit profil">
      <form className="confirmation-dialog profile-editor" onSubmit={async (event) => { event.preventDefault(); setSaving(true); try { await onSave(fullName); } finally { setSaving(false); } }}>
        <h2>Upravit profil</h2>
        <label>Zobrazované jméno<input value={fullName} minLength={2} maxLength={100} required disabled={!editable} onChange={(event) => setFullName(event.target.value)} /></label>
        <label>E-mail<input value={profile.email ?? ""} readOnly /></label>
        <label>Role<input value={roleLabel(accessRole(profile))} readOnly /></label>
        {!editable && <p className="hint">Uložení profilu bude dostupné po aplikaci migrace 01600.</p>}
        <div className="confirmation-actions"><button type="button" onClick={onCancel}>Zrušit</button><button className="primary" disabled={!editable || saving}>{saving ? "Ukládám…" : "Uložit"}</button></div>
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
            onCancel={() => setPurchaseEditor(null)}
            onSave={async (draft) => {
              await mutate(() => schoolRepository.savePurchaseItem(draft, userId));
              setPurchaseEditor(null);
            }}
          />
        )}
        {needed.map((item) => (
          <article className="operation-card" key={item.id}>
            <div><b>{item.name}</b>{item.note && <span>{item.note}</span>}</div>
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
                <div><b>{item.name}</b>{item.note && <span>{item.note}</span>}</div>
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
            onCancel={() => setIncidentEditor(null)}
            onSave={async (draft) => {
              await mutate(() => schoolRepository.saveIncident(draft, userId));
              setIncidentEditor(null);
            }}
          />
        )}
        {openIncidents.map((item) => (
          <article className="operation-card incident" key={item.id}>
            <div><b>⚠ {item.title}</b><span>{[item.room, item.floor].filter(Boolean).join(" · ") || "Místo neuvedeno"}</span>{item.note && <small>{item.note}</small>}</div>
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
                <div><b>{item.title}</b><span>{[item.room, item.floor].filter(Boolean).join(" · ")}</span></div>
                {(canManage || item.createdBy === userId) && data.editable && <div className="operation-actions"><button disabled={mutating} onClick={() => void mutate(() => schoolRepository.setIncidentStatus(item.id, "reported")).catch(() => undefined)}>{mutating ? "Ukládám…" : "Znovu otevřít"}</button><button disabled={mutating} onClick={() => void mutate(() => schoolRepository.archiveIncident(item.id)).catch(() => undefined)}>Archivovat</button></div>}
              </article>
            ))}
          </details>
        )}
      </section>
    </div>
  );
}

function PurchaseEditor({ item, onSave, onCancel }: { item?: StockItem; onSave: (item: { id?: string; name: string; note: string }) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState(item?.name ?? "");
  const [note, setNote] = useState(item?.note ?? "");
  const [saving, setSaving] = useState(false);
  return (
    <form className="operation-editor" onSubmit={async (event) => { event.preventDefault(); setSaving(true); try { await onSave({ id: item?.id, name, note }); } finally { setSaving(false); } }}>
      <label>Název<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Např. Gumové rukavice" required /></label>
      <label>Poznámka<textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} placeholder="Volitelná upřesňující poznámka" /></label>
      <div className="editor-actions"><button type="button" onClick={onCancel}>Zrušit</button><button disabled={saving}>{saving ? "Ukládám…" : "Uložit"}</button></div>
    </form>
  );
}

function IncidentEditor({ item, rooms, onSave, onCancel }: { item?: Incident; rooms: OperationsData["rooms"]; onSave: (item: { id?: string; title: string; note: string; roomId?: string | null }) => Promise<void>; onCancel: () => void }) {
  const [title, setTitle] = useState(item?.title ?? "");
  const [note, setNote] = useState(item?.note ?? "");
  const [roomId, setRoomId] = useState(item?.roomId ?? "");
  const [saving, setSaving] = useState(false);
  return (
    <form className="operation-editor" onSubmit={async (event) => { event.preventDefault(); setSaving(true); try { await onSave({ id: item?.id, title, note, roomId: roomId || null }); } finally { setSaving(false); } }}>
      <label>Co je rozbité<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Např. Nefunguje světlo" required /></label>
      <label>Místnost<select value={roomId} onChange={(event) => setRoomId(event.target.value)}><option value="">Místo neuvedeno</option>{rooms.map((room) => <option key={room.id} value={room.id}>{room.floor} · {room.name}</option>)}</select></label>
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
  const context = resolveCleaningDay(date, records);
  return tasks.filter((task) => task.active && task.roomActive !== false)
    .filter((task) => isTaskDueForCleaningDay(taskScheduleInput(task), context));
}

function floorPictogram(floor: string) {
  const number = floor.match(/^[1-4]/)?.[0];
  return number ? `${number}F` : (floor === "Schodiště" ? "SCH" : "•");
}

function CalendarDayDetail({ date, tasks, context }: { date: string; tasks: Task[]; context: CleaningDayContext }) {
  const floors = new Map<string, Map<string, Task[]>>();
  tasks.forEach((task) => {
    const rooms = floors.get(task.floor) ?? new Map<string, Task[]>();
    rooms.set(task.room, [...(rooms.get(task.room) ?? []), task]);
    floors.set(task.floor, rooms);
  });
  return (
    <section className="calendar-day-detail">
      <header><span><small>{context.kind === "extraordinary" ? "MIMOŘÁDNÝ ÚKLID" : context.kind === "rescheduled" ? "PŘESUNUTÝ ÚKLID" : "PLÁN DNE"}</small><b>{formatDate(date)}</b></span><strong>{tasks.length} úkolů</strong></header>
      {context.note && <p>{context.note}</p>}
      {[...floors.entries()].sort(([a], [b]) => a.localeCompare(b, "cs")).map(([floor, rooms]) => (
        <details key={floor} open className="calendar-detail-floor">
          <summary><b>{floor}</b><span>{[...rooms.values()].reduce((sum, items) => sum + items.length, 0)}</span></summary>
          {[...rooms.entries()].map(([room, roomTasks]) => (
            <article key={room} className="calendar-detail-room"><b>{room}</b><div>{roomTasks.sort((a, b) => a.sortOrder - b.sortOrder).map((task) => <span key={task.id}><i>{activityTypes[task.activityType]?.icon ?? "✓"}</i>{task.title}</span>)}</div></article>
          ))}
        </details>
      ))}
      {!tasks.length && <p className="hint">V tento den není naplánovaný úklid.</p>}
    </section>
  );
}

function CleaningCalendar({
  records,
  available,
  taskSelectionAvailable,
  canManage,
  buildingId,
  tasks,
  onSave,
  onCancel,
}: {
  records: CleaningDayRecord[];
  available: boolean;
  taskSelectionAvailable: boolean;
  canManage: boolean;
  buildingId: string;
  tasks: Task[];
  onSave: (draft: CleaningDayDraft) => Promise<void>;
  onCancel: (id: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState<CleaningDayRecord | "new" | null>(null);
  const today = localDateKey();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [selectedDate, setSelectedDate] = useState(today);
  const future = records.filter((item) => item.executionDate >= today).sort((a, b) => a.executionDate.localeCompare(b.executionDate));
  const calendarDays = useMemo(() => monthGridDates(month).map((date) => ({
    date,
    tasks: dueTasksForDate(tasks, records, date),
    context: resolveCleaningDay(date, records),
  })), [month, records, tasks]);
  const selected = calendarDays.find((item) => item.date === selectedDate)
    ?? { date: selectedDate, tasks: dueTasksForDate(tasks, records, selectedDate), context: resolveCleaningDay(selectedDate, records) };
  const moveMonth = (amount: number) => {
    const [year, monthNumber] = month.split("-").map(Number);
    const next = new Date(Date.UTC(year, monthNumber - 1 + amount, 1));
    const key = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
    setMonth(key);
    setSelectedDate(`${key}-01`);
  };
  const monthLabel = new Intl.DateTimeFormat("cs-CZ", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T12:00:00Z`));
  return (
    <div className="cleaning-calendar">
      <section className="panel calendar-intro">
        <p className="eyebrow">PRAVIDELNÝ PLÁN</p>
        <b>Pondělí · středa · pátek</b>
        <small>Výjimky níže jsou uložené samostatně. Google Calendar zatím není připojený.</small>
      </section>
      {!available && (
        <div className="notice">Správa skutečných mimořádných a přesunutých dnů bude dostupná po zkontrolování a aplikaci migrace 01300.</div>
      )}
      {available && canManage && !editing && (
        <button className="primary-action" onClick={() => setEditing("new")}>+ Přidat úklidový den</button>
      )}
      {available && editing && (
        <CleaningDayEditor
          record={editing === "new" ? undefined : editing}
          buildingId={buildingId}
          tasks={tasks}
          taskSelectionAvailable={taskSelectionAvailable}
          onCancel={() => setEditing(null)}
          onSave={async (draft) => { await onSave(draft); setEditing(null); }}
        />
      )}
      <section className="month-calendar" aria-label="Měsíční plán úklidu">
        <header><button onClick={() => moveMonth(-1)} aria-label="Předchozí měsíc">‹</button><h2>{monthLabel}</h2><button onClick={() => moveMonth(1)} aria-label="Další měsíc">›</button></header>
        <div className="calendar-weekdays">{weekdays.map((day) => <b key={day}>{day}</b>)}</div>
        <div className="calendar-grid">
          {calendarDays.map((item) => {
            const floors = [...new Set(item.tasks.map((task) => task.floor).filter((floor) => floor !== "Společné úkoly"))];
            const activities = [...new Set(item.tasks.map((task) => task.activityType))];
            return (
              <button
                key={item.date}
                className={`calendar-day ${item.date.slice(0, 7) === month ? "" : "outside"} ${item.date === today ? "today" : ""} ${item.date === selectedDate ? "selected" : ""} ${item.tasks.length ? "has-work" : ""}`}
                onClick={() => setSelectedDate(item.date)}
                aria-label={`${formatDate(item.date)}, ${item.tasks.length} úkolů`}
              >
                <strong>{Number(item.date.slice(8, 10))}</strong>
                <span className="floor-pictograms">{floors.slice(0, 4).map((floor) => <i key={floor}>{floorPictogram(floor)}</i>)}</span>
                <span className="activity-pictograms">{activities.slice(0, 4).map((activity) => <i key={activity}>{activityTypes[activity]?.icon ?? "✓"}</i>)}</span>
                {item.context.kind === "extraordinary" && <em>M</em>}
                {item.context.kind === "rescheduled" && <em>P</em>}
              </button>
            );
          })}
        </div>
        <div className="calendar-legend"><span><i>1F–4F</i> patro</span><span><i>SCH</i> schodiště</span>{(["vacuum","mop","toilet","trash","tables","windows","doors","tiles","surfaces","laundry","deep_clean"] as ActivityType[]).map((type) => <span key={type}><i>{activityTypes[type].icon}</i>{activityTypes[type].label}</span>)}</div>
      </section>
      <CalendarDayDetail date={selected.date} tasks={selected.tasks} context={selected.context} />
      <section className="calendar-list">
        <h2>Plánované výjimky</h2>
        {future.map((item) => (
          <article key={item.id} className={item.status === "cancelled" ? "cancelled" : ""}>
            <div>
              <small>{item.kind === "extraordinary" ? "MIMOŘÁDNÝ ÚKLID" : "PŘESUNUTÝ ÚKLID"}</small>
              <b>{item.title}</b>
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
  buildingId,
  tasks,
  taskSelectionAvailable,
  onCancel,
  onSave,
}: {
  record?: CleaningDayRecord;
  buildingId: string;
  tasks: Task[];
  taskSelectionAvailable: boolean;
  onCancel: () => void;
  onSave: (draft: CleaningDayDraft) => Promise<void>;
}) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const [kind, setKind] = useState<"extraordinary" | "rescheduled">(record?.kind ?? "extraordinary");
  const [executionDate, setExecutionDate] = useState(record?.executionDate ?? localDateKey(tomorrow));
  const [sourceDate, setSourceDate] = useState(record?.sourceDate ?? localDateKey());
  const [title, setTitle] = useState(record?.title ?? "");
  const [note, setNote] = useState(record?.note ?? "");
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(
    () => selectedTasksForExtraordinaryDay(tasks, record?.executionDate ?? localDateKey(tomorrow), record?.taskOverrides),
  );
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (kind !== "extraordinary") return;
    setSelectedTaskIds(selectedTasksForExtraordinaryDay(tasks, executionDate, record?.taskOverrides));
  }, [kind, executionDate, record?.id, record?.taskOverrides, tasks]);
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
          tasks={tasks}
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
