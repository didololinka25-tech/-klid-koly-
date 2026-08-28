import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { defaultShifts } from "./data";
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
  type ManagedRoom,
  type PlanOptions,
  type Profile,
  type UserProfile,
} from "./schoolRepository";
import { isSupabaseConfigured } from "./supabase";
import type { ActivityType, Attendance, Frequency, Task } from "./types";

type Section =
  | "Dnes"
  | "Správa"
  | "Uživatelé"
  | "Docházka"
  | "Kalendář"
  | "Zásoby"
  | "Praní"
  | "Závady"
  | "Nastavení";
const sections: Section[] = [
  "Dnes",
  "Správa",
  "Uživatelé",
  "Docházka",
  "Kalendář",
  "Zásoby",
  "Praní",
  "Závady",
  "Nastavení",
];
const icon: Record<Section, string> = {
  Dnes: "☀",
  Správa: "✓",
  Uživatelé: "♙",
  Docházka: "◷",
  Kalendář: "▣",
  Zásoby: "▤",
  Praní: "♨",
  Závady: "⚠",
  Nastavení: "⚙",
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
  disinfect: { icon: "✦", label: "Dezinfekce" },
  tables: { icon: "▤", label: "Stoly" },
  windows: { icon: "▦", label: "Okna" },
  laundry: { icon: "♨", label: "Praní" },
  other: { icon: "✓", label: "Ostatní" },
};
const weekdays = ["Po", "Út", "St", "Čt", "Pá", "So", "Ne"];
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
  const [attendance, setAttendance] = useState<Attendance[]>([]);
  const [attendanceView, setAttendanceView] = useState<Attendance[]>([]);
  const [attendanceWorkers, setAttendanceWorkers] = useState<AttendanceWorker[]>([]);
  const [selectedAttendanceWorker, setSelectedAttendanceWorker] = useState("");
  const [attendanceSettings, setAttendanceSettings] = useState<AttendanceSettings>({
    plannedShiftsPerWeek: 3,
    configurable: false,
  });
  const [attendanceRefresh, setAttendanceRefresh] = useState(0);
  const [section, setSection] = useState<Section>("Dnes");
  const [notice, setNotice] = useState("");
  const [planOptions, setPlanOptions] = useState<PlanOptions>({
    buildings: [],
    floors: [],
    rooms: [],
  });
  const [editing, setEditing] = useState<Task | null>(null);
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
        return;
      }
      const taskResult = await Promise.resolve(
        schoolRepository.tasks(activeProfile, canManageOperations(activeProfile)),
      ).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason) => ({ status: "rejected" as const, reason }),
      );
      if (taskResult.status === "fulfilled") {
        setTasks(taskResult.value.tasks);
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
      setAttendance([]);
      setAttendanceView([]);
      setAttendanceWorkers([]);
      setSelectedAttendanceWorker("");
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
    if (!target || !target.canComplete) return;
    if (
      target.prerequisite &&
      !tasks.find((task) => task.id === target.prerequisite)?.done
    ) {
      setNotice("Nejdříve je potřeba zamést nebo vysát.");
      return;
    }
    try {
      setNotice("");
      await schoolRepository.setCompletion(id, !target.done);
      await load(session, profile);
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Úkol se nepodařilo uložit.",
      );
    }
  };
  const completeMany = async (selectedTasks: Task[]) => {
    if (selectedTasks.some((task) => !task.canComplete)) return;
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
      await load(session, profile);
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Úkoly místnosti se nepodařilo uložit.",
      );
      throw error;
    }
  };
  const clock = async () => {
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
          start: startedAt.toISOString(),
          date: `${startedAt.getFullYear()}-${String(startedAt.getMonth() + 1).padStart(2, "0")}-${String(startedAt.getDate()).padStart(2, "0")}`,
        };
        setAttendance((records) => replaceRecord(records, optimistic));
        if ((selectedAttendanceWorker || profile.id) === profile.id) {
          setAttendanceView((records) => replaceRecord(records, optimistic));
        }
        const saved = await schoolRepository.startAttendance(profile.id);
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
    }
  };
  const saveAttendance = async (
    id: string,
    startedAt: string,
    endedAt?: string,
  ) => {
    try {
      setNotice("");
      await schoolRepository.updateAttendance(id, startedAt, endedAt);
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
  const saveTask = async (task: Task) => {
    try {
      setNotice("");
      await schoolRepository.saveTask(task);
      setEditing(null);
      await load(session, profile);
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Plán se nepodařilo uložit.",
      );
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
  const visible =
    section === "Dnes"
      ? tasks.filter((task) => task.active && task.dueToday)
      : tasks;
  const navigation = sections.filter((item) => {
    if (item === "Správa") return canManageOperations(profile);
    if (item === "Uživatelé") return Boolean(profile.is_owner);
    if (item === "Docházka") return canWork(profile);
    if (accessRole(profile) === "visitor") return ["Dnes", "Nastavení"].includes(item);
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
        <button
          className="avatar"
          aria-label="Odhlásit"
          title="Odhlásit"
          onClick={() => schoolRepository.signOut()}
        >
          {profile.full_name[0]}
        </button>
      </header>
      {notice && <div className="notice">{notice}</div>}
      {section === "Dnes" && (
        <>
          {canWork(profile) && <TodayAttendance records={attendance} onClock={clock} />}
          <section className="hero">
            <span>
              {isTestCleaningDay
                ? "Testovací zobrazení pondělního úklidového dne."
                : [1, 3, 5].includes(new Date().getDay())
                  ? "Dnes je standardní úklidový den."
                  : "Dnes není pravidelný úklidový den."}
            </span>
            <strong>
              {visible.filter((task) => task.done).length} / {visible.length}{" "}
              hotovo
            </strong>
          </section>
          {accessRole(profile) === "visitor" && (
            <p className="readonly-note">Návštěvnický přístup je pouze pro čtení.</p>
          )}
          <TaskHierarchy
            tasks={visible}
            onComplete={complete}
            onCompleteAll={completeMany}
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
          onSaveRoom={saveRoom}
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
          currentUserId={profile.id}
          isCaretaker={canManageOperations(profile)}
          onClock={clock}
          ownRecords={attendance}
          onSaveAttendance={saveAttendance}
          onDeleteAttendance={deleteAttendance}
          onSaveSettings={saveAttendanceSettings}
        />
      )}
      {section === "Kalendář" && (
        <Placeholder
          title="Plán úklidu"
          text="Připraveno pro budoucí propojení sdíleného Google Kalendáře a kontrolu kolizí školních akcí."
        />
      )}
      {section === "Zásoby" && (
        <Placeholder
          title="Zásoby"
          text="Datový model zásob je připraven. Správu zásob doplníme v další fázi."
        />
      )}
      {section === "Praní" && (
        <Placeholder
          title="Praní"
          text="Datový model praní je samostatný a nezapočítává se do docházky."
        />
      )}
      {section === "Závady" && (
        <Placeholder
          title="Závady"
          text="Datový model závad a budoucích fotografií je připraven."
        />
      )}
      {section === "Nastavení" && (
        <section className="panel">
          <h2>Budovy a výchozí směny</h2>
          <div className="building">
            <b>Škola</b>
            <span>aktivní budova</span>
          </div>
          <div className="building muted">
            <b>Školka</b>
            <span>připravena k přidání</span>
          </div>
          {defaultShifts.map((shift) => (
            <div className="shift" key={shift.worker}>
              <span>{shift.worker}</span>
              <span>
                {shift.start}–{shift.end}
              </span>
            </div>
          ))}
          <p className="hint">
            Přihlášen: {profile.full_name} ·{" "}
            {roleLabel(accessRole(profile))}
          </p>
        </section>
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
          </button>
        ))}
      </nav>
    </main>
  );
}

const DPP_YEAR_LIMIT_HOURS = 300;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
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
  const remainingHours = Math.max(0, DPP_YEAR_LIMIT_HOURS - yearHours);
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
}: {
  records: Attendance[];
  onClock: () => Promise<void>;
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
            <span>Příchod: {formatTime(open.start)}</span>
            <strong>Pracuji: {formatDuration(shiftDuration(open, now))}</strong>
          </>
        )}
        {!open && todayRecords.length > 0 && (
          <strong>Dnes odpracováno: {formatDuration(todayMs)}</strong>
        )}
      </div>
      {(!todayRecords.length || open) && (
        <button onClick={() => void onClock()}>
          {open ? "Odchod" : "Příchod"}
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
  currentUserId,
  isCaretaker,
  onClock,
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
  currentUserId: string;
  isCaretaker: boolean;
  onClock: () => Promise<void>;
  ownRecords: Attendance[];
  onSaveAttendance: (
    id: string,
    startedAt: string,
    endedAt?: string,
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
    () => attendanceMetrics(records, now, settings.plannedShiftsPerWeek),
    [records, now, settings.plannedShiftsPerWeek],
  );
  const isOwn = selectedWorkerId === currentUserId;
  const progress = Math.min(100, (metrics.yearHours / 300) * 100);
  const selectedName =
    workers.find((worker) => worker.id === selectedWorkerId)?.name ?? "Pracovník";
  const yearWarning =
    metrics.yearHours >= 300
      ? "Roční limit DPP vyčerpán. Evidence dále zaznamenává skutečnou práci."
      : metrics.yearHours >= 280
        ? "Pozor, roční fond DPP je téměř vyčerpán."
        : metrics.yearHours >= 250
          ? "Roční fond DPP se blíží limitu 300 hodin."
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
      {isOwn && <TodayAttendance records={ownRecords} onClock={onClock} />}
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
            {metrics.yearHours.toFixed(1)} / {DPP_YEAR_LIMIT_HOURS} h
          </strong>
          <span>Zbývá {metrics.remainingHours.toFixed(1)} h</span>
        </article>
      </div>
      <div className="dpp-progress" aria-label="Čerpání ročního limitu DPP">
        <span style={{ width: `${progress}%` }} />
      </div>
      {yearWarning && (
        <div
          className={`attendance-alert ${metrics.yearHours >= 280 ? "danger" : ""}`}
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
          onSave={async (start, end) => {
            await onSaveAttendance(editingRecord.id, start, end);
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
  const date = new Date(value);
  return `${localDateKey(date)}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function AttendanceEditor({
  record,
  onCancel,
  onSave,
}: {
  record: Attendance;
  onCancel: () => void;
  onSave: (start: string, end?: string) => Promise<void>;
}) {
  const [start, setStart] = useState(localDateTimeInput(record.start));
  const [end, setEnd] = useState(
    record.end ? localDateTimeInput(record.end) : "",
  );
  return (
    <form
      className="task-editor attendance-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(start, end || undefined);
      }}
    >
      <h2>Opravit směnu</h2>
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
        <button type="button" onClick={onCancel}>
          Zrušit
        </button>
        <button type="submit">Uložit opravu</button>
      </div>
    </form>
  );
}

function TaskHierarchy({
  tasks,
  onComplete,
  onCompleteAll,
}: {
  tasks: Task[];
  onComplete: (id: string) => Promise<void>;
  onCompleteAll: (tasks: Task[]) => Promise<void>;
}) {
  const common = tasks.filter((task) => !task.roomId);
  const floorGroups = new Map<string, Task[]>();
  tasks
    .filter((task) => task.roomId)
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
          <TaskRows tasks={common} onComplete={onComplete} />
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
          />
        ))}
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
}: {
  label: string;
  tasks: Task[];
  onComplete: (id: string) => Promise<void>;
  onCompleteAll: (tasks: Task[]) => Promise<void>;
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
}: {
  room: string;
  tasks: Task[];
  onComplete: (id: string) => Promise<void>;
  onCompleteAll: (tasks: Task[]) => Promise<void>;
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
      <TaskRows tasks={tasks} onComplete={onComplete} />
    </section>
  );
}

function TaskRows({
  tasks,
  onComplete,
}: {
  tasks: Task[];
  onComplete: (id: string) => Promise<void>;
}) {
  return (
    <div className="activity-grid">
      {[...tasks]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((task) => {
          const activity = activityTypes[task.activityType] ?? activityTypes.other;
          return (
            <button
              className={task.done ? "activity-check done" : "activity-check"}
              disabled={!task.canComplete}
              onClick={() => void onComplete(task.id)}
              aria-pressed={task.done}
              aria-label={`${task.done ? "Zrušit dokončení" : "Dokončit"}: ${task.title}`}
              title={`${task.title}${task.prerequisite ? " – nejdříve zamést nebo vysát" : ""}`}
              key={task.id}
            >
              <span aria-hidden="true">{task.done ? "✓" : activity.icon}</span>
              <small>{activity.label}</small>
            </button>
          );
        })}
    </div>
  );
}

function Management({
  tasks,
  options,
  editing,
  onEdit,
  onCancel,
  onSaveTask,
  onSaveRoom,
}: {
  tasks: Task[];
  options: PlanOptions;
  editing: Task | null;
  onEdit: (task: Task) => void;
  onCancel: () => void;
  onSaveTask: (task: Task) => Promise<void>;
  onSaveRoom: (room: ManagedRoom) => Promise<void>;
}) {
  const [view, setView] = useState<"plan" | "rooms">("plan");
  return (
    <>
      <div className="management-tabs" role="tablist" aria-label="Správa školy">
        <button
          className={view === "plan" ? "active" : ""}
          onClick={() => setView("plan")}
          role="tab"
          aria-selected={view === "plan"}
        >
          Plán úklidu
        </button>
        <button
          className={view === "rooms" ? "active" : ""}
          onClick={() => setView("rooms")}
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
        />
      ) : (
        <RoomManager options={options} onSave={onSaveRoom} />
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
}: {
  tasks: Task[];
  options: PlanOptions;
  editing: Task | null;
  onEdit: (task: Task) => void;
  onCancel: () => void;
  onSave: (task: Task) => Promise<void>;
}) {
  const addTask = () =>
    onEdit({
      id: "",
      room: "Společný úkol",
      floor: "Společné úkoly",
      floorSort: -1,
      building: "Škola",
      title: "",
      activityType: "other",
      frequency: "denně",
      assignedTo: "nepřiřazeno",
      done: false,
      dueToday: false,
      sortOrder: 10,
      scheduleDays: [1, 3, 5],
      monthlyDay: null,
      workPartId: null,
      assignmentMode: "fixed",
      rotationAnchorDate: null,
      rotationIntervalWeeks: 1,
      active: true,
      rotationAssignments: [],
    });
  return (
    <section className="plan-manager">
      <p className="hint">
        Správce může přidat nebo upravit plán. Deaktivovaný úkol zůstane v
        historii, ale nezobrazí se pracovníkům.
      </p>
      {editing ? (
        <TaskEditor
          task={editing}
          options={options}
          onCancel={onCancel}
          onSave={onSave}
        />
      ) : (
        <>
          <button className="add-task" onClick={addTask}>
            + Nový úkol
          </button>
          <div className="plan-list">
            {[...tasks]
              .sort(
                (a, b) =>
                  a.floorSort - b.floorSort ||
                  a.room.localeCompare(b.room, "cs") ||
                  a.sortOrder - b.sortOrder,
              )
              .map((task) => (
                <button
                  key={task.id}
                  className="plan-row"
                  onClick={() => onEdit({ ...task })}
                >
                  <span>
                    <b>
                      {task.floor} · {task.room}
                    </b>
                    <small>
                      {task.title} · {task.frequency}
                      {task.active ? "" : " · neaktivní"}
                    </small>
                  </span>
                  <i>Upravit</i>
                </button>
              ))}
          </div>
        </>
      )}
    </section>
  );
}

function RoomManager({
  options,
  onSave,
}: {
  options: PlanOptions;
  onSave: (room: ManagedRoom) => Promise<void>;
}) {
  const school =
    options.buildings.find((building) => building.name === "Škola") ??
    options.buildings[0];
  const schoolFloors = options.floors
    .filter((floor) => !school || floor.buildingId === school.id)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const [selectedFloorId, setSelectedFloorId] = useState("");
  const [editingRoom, setEditingRoom] = useState<ManagedRoom | null>(null);
  const activeFloorId = schoolFloors.some(
    (floor) => floor.id === selectedFloorId,
  )
    ? selectedFloorId
    : (schoolFloors[0]?.id ?? "");
  const rooms = options.rooms
    .filter((room) => room.floorId === activeFloorId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "cs"));
  const addRoom = () => {
    const floor = schoolFloors.find((item) => item.id === activeFloorId);
    if (!floor || !school) return;
    setEditingRoom({
      id: "",
      buildingId: school.id,
      floorId: floor.id,
      name: "",
      active: true,
      sortOrder: (rooms[rooms.length - 1]?.sortOrder ?? 0) + 10,
    });
  };
  const save = async (room: ManagedRoom) => {
    await onSave(room);
    setSelectedFloorId(room.floorId ?? "");
    setEditingRoom(null);
  };
  return (
    <section className="room-manager">
      {editingRoom ? (
        <RoomEditor
          room={editingRoom}
          options={options}
          onCancel={() => setEditingRoom(null)}
          onSave={save}
        />
      ) : (
        <>
          <label className="floor-picker">
            Patro / sekce
            <select
              value={activeFloorId}
              onChange={(event) => setSelectedFloorId(event.target.value)}
            >
              {schoolFloors.map((floor) => (
                <option key={floor.id} value={floor.id}>
                  {floor.name}
                </option>
              ))}
            </select>
          </label>
          <div className="room-manager-heading">
            <div>
              <h2>
                {schoolFloors.find((floor) => floor.id === activeFloorId)
                  ?.name ?? "Místnosti"}
              </h2>
              <small>{rooms.length} místností</small>
            </div>
            <button onClick={addRoom}>+ Místnost</button>
          </div>
          <div className="room-admin-list">
            {rooms.map((room) => (
              <button
                key={room.id}
                className={room.active ? "room-admin-row" : "room-admin-row inactive"}
                onClick={() =>
                  setEditingRoom({
                    id: room.id,
                    buildingId: room.buildingId,
                    floorId: room.floorId,
                    name: room.name,
                    active: room.active,
                    sortOrder: room.sortOrder,
                  })
                }
              >
                <span>
                  <b>{room.name}</b>
                  <small>
                    Pořadí {room.sortOrder}
                    {room.active ? "" : " · neaktivní"}
                  </small>
                </span>
                <i>Upravit</i>
              </button>
            ))}
            {rooms.length === 0 && (
              <p className="hint">V této sekci zatím nejsou žádné místnosti.</p>
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
}: {
  room: ManagedRoom;
  options: PlanOptions;
  onCancel: () => void;
  onSave: (room: ManagedRoom) => Promise<void>;
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
      <label className="switch">
        <input
          type="checkbox"
          checked={draft.active}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              active: event.target.checked,
            }))
          }
        />
        Aktivní místnost
      </label>
      <p className="hint">
        Deaktivace místnost nesmaže. Úkoly a historie zůstanou navázané na stejné
        ID.
      </p>
      <div className="editor-actions">
        <button type="button" onClick={onCancel}>
          Zrušit
        </button>
        <button type="submit">Uložit místnost</button>
      </div>
    </form>
  );
}

function TaskEditor({
  task,
  options,
  onCancel,
  onSave,
}: {
  task: Task;
  options: PlanOptions;
  onCancel: () => void;
  onSave: (task: Task) => Promise<void>;
}) {
  const [draft, setDraft] = useState(task);
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
        void onSave(draft);
      }}
    >
      <h2>{task.id ? "Upravit úkol" : "Nový úkol"}</h2>
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
      <label>
        Místnost / společný úkol
        <select
          value={draft.roomId ?? ""}
          onChange={(event) => setRoom(event.target.value)}
        >
          <option value="">Společný úkol pro školu</option>
          {options.rooms.map((room) => (
            <option key={room.id} value={room.id}>
              {room.floor} · {room.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Patro / sekce
        <input value={draft.floor} readOnly />
      </label>
      <label>
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
      </label>
      {draft.frequency !== "měsíčně" && draft.frequency !== "mimořádně" && (
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
      {draft.frequency === "měsíčně" && (
        <label>
          Den v měsíci
          <input
            type="number"
            min="1"
            max="31"
            value={draft.monthlyDay ?? 1}
            onChange={(event) =>
              update("monthlyDay", Number(event.target.value))
            }
          />
        </label>
      )}
      <label>
        Pořadí
        <input
          type="number"
          value={draft.sortOrder}
          onChange={(event) => update("sortOrder", Number(event.target.value))}
        />
      </label>
      <label className="switch">
        <input
          type="checkbox"
          checked={draft.active}
          onChange={(event) => update("active", event.target.checked)}
        />{" "}
        Aktivní úkol
      </label>
      <div className="editor-actions">
        <button type="button" onClick={onCancel}>
          Zrušit
        </button>
        <button type="submit">Uložit plán</button>
      </div>
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
  return (
    <section className="user-management">
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
    <article className={`user-card ${active ? "" : "inactive"}`}>
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

function Placeholder({ title, text }: { title: string; text: string }) {
  return (
    <section className="empty">
      <span>○</span>
      <h2>{title}</h2>
      <p>{text}</p>
    </section>
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
