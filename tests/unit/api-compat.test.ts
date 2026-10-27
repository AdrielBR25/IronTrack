// Compatibilidade da API interna (IronTrack 2.0 F01/P03). Lista dos exports de cada módulo
// de src/lib e src/db na linha de base (f564071), antes da modularização. Todo nome
// continua exportado pelo mesmo caminho, exceto os listados em MOVED (com o novo endereço).
import { describe, expect, it } from 'vitest';

const BASELINE: Record<string, string[]> = {
  '@/db/db': ['DB_SCHEMA_VERSION', 'IronTrackDB', 'MigrationError', 'db', 'describeOpenError', 'ensureDefaultProfile', 'getSettings', 'mergeSettings', 'migration', 'requestPersistentStorage', 'saveSettings', 'setDb'],
  '@/db/profiles': ['ensureDefaultProfile', 'getCurrentProfile', 'getCurrentProfileId', 'getProfileById', 'renameProfile'],
  '@/db/repo': ['addPhoto', 'addRoutine', 'clearDayOverride', 'cloneWorkout', 'completeSession', 'completedSessions', 'deleteBodyEntry', 'deletePhoto', 'deleteRoutine', 'deleteSession', 'discardSession', 'duplicateRoutine', 'getActiveSession', 'getRotation', 'normIndex', 'saveBodyEntry', 'saveBodyEntryWithPhotos', 'saveRoutine', 'saveRoutineKeepPointer', 'saveSession', 'setActiveRoutine', 'setDayOverride', 'setNextWorkout', 'skipNextWorkout', 'startSession', 'updateSessionNotes'],
  '@/lib/alerts': ['audioAvailable', 'closeRestNotifications', 'notificationState', 'playBeep', 'requestNotificationPermission', 'showLocalNotification', 'unlockAudio', 'vibrate', 'vibrationAvailable'],
  '@/lib/backup': ['BACKUP_APP', 'BACKUP_LIMITS', 'BACKUP_SCHEMA_VERSION', 'BackupRestoreError', 'PROFILE_MERGE_BLOCKED_MESSAGE', 'PROFILE_TRANSFER_REQUIRED_MESSAGE', 'STALE_PREVIEW_MESSAGE', 'assignOwner', 'checkBackupIntegrity', 'checkBackupSize', 'checkLocalIntegrity', 'exportBackup', 'migrateBackup', 'parseBackup', 'previewRestore', 'readLocalState', 'readSnapshot', 'restoreBackupMerge', 'restoreBackupReplace', 'restoreIdentity'],
  '@/lib/bodyEvolution': ['BODY_METRICS', 'evolutionSummary', 'metricByKey', 'metricChanges', 'skinfoldChanges', 'verdict'],
  '@/lib/bodyPdf': ['evaluationToEntry', 'extractPdfItems', 'newMonthsOnly', 'parseAnthropometricItems'],
  '@/lib/bodyRegions': ['REGIONS', 'availableMeasures', 'beforeScale', 'compare', 'regionById'],
  '@/lib/bodySchema': ['BODY_FORMAT', 'parseBodyJson'],
  '@/lib/dates': ['addDays', 'fmtDateLong', 'fmtDateShort', 'fmtDateTime', 'fmtTime', 'fromISODate', 'startOfDayTs', 'startOfWeek', 'toISODate', 'todayISO', 'tsToISODate', 'weekday', 'weekdayLong', 'weekdayShort'],
  '@/lib/defaults': ['DEFAULT_MUSCLE_GROUPS', 'DEFAULT_SETTINGS', 'GOAL_LABEL'],
  '@/lib/install': ['getInstallEvent', 'initInstallCapture', 'isStandalone', 'promptInstall', 'subscribeInstall'],
  '@/lib/integrity': ['checkIntegrity', 'isValidISODate', 'recordKey', 'snapshotFingerprint', 'stableStringify'],
  '@/lib/merge': ['applyPlan', 'planMerge'],
  '@/lib/profile': ['DEFAULT_PROFILE_NAME', 'PROFILE_NAME_MAX', 'ProfileError', 'generateProfileId', 'isValidProfileId', 'newDefaultProfile', 'normalizeProfileName', 'pickDefaultProfile', 'shortProfileId'],
  '@/lib/progression': ['suggestProgression'],
  '@/lib/restTimer': ['adjustRest', 'isFinished', 'isPaused', 'pauseRest', 'progress', 'remainingMs', 'resumeRest', 'startRest'],
  '@/lib/rotation': ['completionPct', 'indexAfter', 'normIndex', 'projectSchedule', 'shouldAdvance', 'skipIndex'],
  '@/lib/routineSchema': ['FICHA_FORMAT', 'FICHA_VERSION', 'fichaSchema', 'fichaToRoutine', 'fmtRepRange', 'formatZodError', 'parseFicha', 'parseJsonText', 'parseRepRange', 'routineToFicha'],
  '@/lib/session': ['addSet', 'buildSession', 'carryForwardWeight', 'completeSet', 'finishSession', 'historyFor', 'nextPending', 'removeSet', 'restAfter', 'sessionProgress', 'setLabel', 'skipExercise', 'skipSet', 'substituteExercise', 'undoSet', 'updateSet'],
  '@/lib/stats': ['consistency', 'exerciseCatalog', 'exerciseSeries', 'sessionsInRange', 'setsByMuscle', 'weekStats', 'weeklySeries'],
  '@/lib/types': ['OWNED_COLLECTIONS'],
  '@/lib/units': ['EQUIPMENT_HINT', 'EQUIPMENT_LABEL', 'KG_PER_LB', 'fromDisplay', 'toDisplay'],
  '@/lib/utils': ['clamp', 'cn', 'downloadJson', 'exerciseKey', 'fmtClock', 'fmtDuration', 'fmtNum', 'parseNum', 'readFileText', 'round', 'uid'],
  '@/lib/volume': ['computeRecords', 'estimate1RM', 'exerciseVolume', 'isValidWorkingSet', 'sessionPRs', 'sessionVolume', 'setVolume', 'validSetCount'],
};

/** Exports que mudaram de lugar de propósito: caminho antigo → nome → novo caminho. */
const MOVED: Record<string, Record<string, string>> = {};

const modules = import.meta.glob(['/src/lib/*.ts', '/src/db/*.ts']);
const load = (path: string) => modules[path.replace('@/', '/src/') + '.ts']?.() as Promise<Record<string, unknown>> | undefined;

describe('exports da linha de base continuam disponíveis', () => {
  for (const [path, names] of Object.entries(BASELINE)) {
    it(path, async () => {
      const mod = await load(path);
      expect(mod, `módulo ${path} não existe mais`).toBeDefined();
      const missing = names.filter((n) => !(n in mod!) && !MOVED[path]?.[n]);
      expect(missing).toEqual([]);
      for (const [name, target] of Object.entries(MOVED[path] ?? {})) {
        const other = await load(target);
        expect(other && name in other, `${name} deveria estar em ${target}`).toBe(true);
      }
    });
  }
});
