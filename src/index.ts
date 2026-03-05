#!/usr/bin/env node

import { Command, Option } from 'commander';
import { execa } from 'execa';
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import which from 'which';

type ProviderId = string;
type ProfileName = string;

type ProviderProfileState = {
  home: string;
  [key: string]: unknown;
};

type ProfileState = {
  providers: Record<ProviderId, ProviderProfileState>;
};

type MuxState = {
  version: number;
  globalProfile?: ProfileName;
  sessionProfiles: Record<string, ProfileName>;
  profiles: Record<ProfileName, ProfileState>;
};

type CommonOptions = {
  profile?: string;
  verbose?: boolean;
  json?: boolean;
  global?: boolean;
};

type ProviderStatus = {
  available: boolean;
  loggedIn?: boolean;
  accountId?: string;
  authMethod?: string;
  message?: string;
};

type ProviderDefinition = {
  id: ProviderId;
  label: string;
  binary: string;
  envKey: string;
  homeDirName: string;
  loginArgs: string[];
  logoutArgs: string[];
  getStatus: (homeDir: string) => Promise<ProviderStatus>;
};

const STATE_VERSION = 3;

const DEFAULT_AMUX_HOME = path.join(homedir(), '.amux');
const MUX_HOME = resolveMuxHome();
const STATE_FILE = path.join(MUX_HOME, 'state.json');
const STATE_BACKUP_FILE = path.join(MUX_HOME, 'state.backup.json');
const PROFILES_DIR = path.join(MUX_HOME, 'profiles');

const EXECUTABLE_CACHE = new Map<string, string | null>();

function resolveMuxHome(): string {
  const envHome = process.env.AMUX_HOME;
  if (envHome) {
    return envHome;
  }

  return DEFAULT_AMUX_HOME;
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function defaultProviderHome(profileName: string, providerId: string): string {
  const provider = PROVIDER_BY_ID.get(providerId);
  const dirName = provider?.homeDirName ?? `${providerId}-home`;
  return path.join(PROFILES_DIR, profileName, dirName);
}

function normalizeSessionProfiles(input: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  const source = asObject(input);
  if (!source) {
    return result;
  }

  for (const [sessionKey, profileName] of Object.entries(source)) {
    if (typeof profileName === 'string' && profileName.trim()) {
      result[sessionKey] = profileName;
    }
  }

  return result;
}

function normalizeProviderEntries(profileName: string, input: unknown): Record<string, ProviderProfileState> {
  const result: Record<string, ProviderProfileState> = {};
  const source = asObject(input);
  if (!source) {
    return result;
  }

  for (const [providerId, value] of Object.entries(source)) {
    if (typeof value === 'string' && value.trim()) {
      result[providerId] = { home: value };
      continue;
    }

    const entry = asObject(value);
    if (!entry) {
      continue;
    }

    const home = entry.home;
    if (typeof home !== 'string' || !home.trim()) {
      continue;
    }

    result[providerId] = {
      ...entry,
      home
    };
  }

  return result;
}

function ensureKnownProviderHomes(profileName: string, providers: Record<string, ProviderProfileState>): void {
  for (const provider of PROVIDERS) {
    const entry = providers[provider.id];
    if (!entry || typeof entry.home !== 'string' || !entry.home.trim()) {
      providers[provider.id] = {
        ...(entry ?? {}),
        home: defaultProviderHome(profileName, provider.id)
      };
    }
  }
}

function migrateProfileState(profileName: string, input: unknown): ProfileState {
  const profileObject = asObject(input);
  const providers = normalizeProviderEntries(profileName, profileObject?.providers);

  // v1/v2 compatibility: preserve existing codex/claude homes if present.
  if (profileObject) {
    const codexHome = profileObject.codexHome;
    if (!providers.codex && typeof codexHome === 'string' && codexHome.trim()) {
      providers.codex = { home: codexHome };
    }

    const claudeConfigDir = profileObject.claudeConfigDir;
    if (!providers.claude && typeof claudeConfigDir === 'string' && claudeConfigDir.trim()) {
      providers.claude = { home: claudeConfigDir };
    }
  }

  ensureKnownProviderHomes(profileName, providers);
  return { providers };
}

function defaultState(): MuxState {
  return {
    version: STATE_VERSION,
    sessionProfiles: {},
    profiles: {}
  };
}

function migrateState(input: unknown): MuxState {
  const source = asObject(input);
  if (!source) {
    return defaultState();
  }

  const profilesSource = asObject(source.profiles) ?? {};
  const profiles: Record<string, ProfileState> = {};

  for (const [profileName, rawProfile] of Object.entries(profilesSource)) {
    profiles[profileName] = migrateProfileState(profileName, rawProfile);
  }

  const globalProfile =
    typeof source.globalProfile === 'string' && source.globalProfile.trim()
      ? source.globalProfile
      : undefined;

  return {
    version: STATE_VERSION,
    globalProfile,
    sessionProfiles: normalizeSessionProfiles(source.sessionProfiles),
    profiles
  };
}

function normalizeState(state: MuxState): MuxState {
  return migrateState(state);
}

function readState(): MuxState {
  ensureDir(MUX_HOME);

  if (!fs.existsSync(STATE_FILE)) {
    return defaultState();
  }

  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return normalizeState(parsed as MuxState);
  } catch {
    return defaultState();
  }
}

function writeState(state: MuxState): void {
  ensureDir(MUX_HOME);

  const normalized = normalizeState(state);
  const payload = `${JSON.stringify(normalized, null, 2)}\n`;
  const tempFile = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;

  try {
    if (fs.existsSync(STATE_FILE)) {
      fs.copyFileSync(STATE_FILE, STATE_BACKUP_FILE);
    }
  } catch {
    // Backup failures should not block a valid state write.
  }

  fs.writeFileSync(tempFile, payload, 'utf8');
  fs.renameSync(tempFile, STATE_FILE);
}

function sanitizeProfile(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('Profile name cannot be empty.');
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    throw new Error('Profile name must match /^[a-zA-Z0-9_-]+$/.');
  }
  return trimmed;
}

function ensureProfile(state: MuxState, profileName: string): void {
  if (!state.profiles[profileName]) {
    state.profiles[profileName] = { providers: {} };
  }

  const migrated = migrateProfileState(profileName, state.profiles[profileName]);
  state.profiles[profileName] = migrated;

  for (const provider of PROVIDERS) {
    const home = state.profiles[profileName].providers[provider.id].home;
    ensureDir(home);
  }
}

function getProfileProviderHome(state: MuxState, profileName: string, providerId: string): string {
  ensureProfile(state, profileName);

  const entry = state.profiles[profileName].providers[providerId];
  if (entry && typeof entry.home === 'string' && entry.home.trim()) {
    return entry.home;
  }

  const home = defaultProviderHome(profileName, providerId);
  state.profiles[profileName].providers[providerId] = {
    ...(entry ?? {}),
    home
  };
  return home;
}

function getProviderHomes(state: MuxState, profileName: string): Record<string, string> {
  const homes: Record<string, string> = {};
  for (const provider of PROVIDERS) {
    homes[provider.id] = getProfileProviderHome(state, profileName, provider.id);
  }
  return homes;
}

function getSessionKey(): string {
  const envSession =
    process.env.AMUX_SESSION ??
    process.env.TERM_SESSION_ID ??
    process.env.ITERM_SESSION_ID ??
    process.env.TMUX_PANE;

  if (envSession) {
    return envSession;
  }

  try {
    const ttyPath = fs.realpathSync('/dev/fd/0');
    if (ttyPath && ttyPath !== '/dev/null') {
      return ttyPath;
    }
  } catch {
    // ignore
  }

  return `pid:${process.ppid}`;
}

function resolveProfile(state: MuxState, options: CommonOptions): string {
  if (options.profile) {
    const selected = sanitizeProfile(options.profile);
    ensureProfile(state, selected);
    return selected;
  }

  const sessionKey = getSessionKey();
  const sessionProfile = state.sessionProfiles[sessionKey];
  if (sessionProfile) {
    ensureProfile(state, sessionProfile);
    return sessionProfile;
  }

  if (state.globalProfile) {
    ensureProfile(state, state.globalProfile);
    return state.globalProfile;
  }

  throw new Error('No active profile. Run `amux use <profile>` first.');
}

function hasActiveProfile(state: MuxState): boolean {
  const sessionKey = getSessionKey();
  return Boolean(state.sessionProfiles[sessionKey] || state.globalProfile);
}

function resolveRunProfileAndArgs(
  state: MuxState,
  options: CommonOptions,
  rawArgs: string[]
): { profile: string; providerArgs: string[] } {
  if (options.profile || rawArgs.length === 0) {
    return {
      profile: resolveProfile(state, options),
      providerArgs: rawArgs
    };
  }

  const first = rawArgs[0];
  if (first.startsWith('-')) {
    return {
      profile: resolveProfile(state, options),
      providerArgs: rawArgs
    };
  }

  let candidate: string;
  try {
    candidate = sanitizeProfile(first);
  } catch {
    return {
      profile: resolveProfile(state, options),
      providerArgs: rawArgs
    };
  }

  const profileExists = Boolean(state.profiles[candidate]);
  const canCreateImplicit = rawArgs.length === 1 && !hasActiveProfile(state);

  if (profileExists || canCreateImplicit) {
    ensureProfile(state, candidate);
    return {
      profile: candidate,
      providerArgs: rawArgs.slice(1)
    };
  }

  return {
    profile: resolveProfile(state, options),
    providerArgs: rawArgs
  };
}

function findExecutable(binary: string): string | null {
  if (EXECUTABLE_CACHE.has(binary)) {
    return EXECUTABLE_CACHE.get(binary) ?? null;
  }

  try {
    const resolved = which.sync(binary);
    EXECUTABLE_CACHE.set(binary, resolved);
    return resolved;
  } catch {
    EXECUTABLE_CACHE.set(binary, null);
    return null;
  }
}

function requireExecutable(provider: ProviderDefinition): string {
  const resolved = findExecutable(provider.binary);
  if (resolved) {
    return resolved;
  }
  throw new Error(`\`${provider.binary}\` command not found in PATH. Install ${provider.label} CLI first.`);
}

async function runProviderWithProfile(
  profileName: string,
  provider: ProviderDefinition,
  args: string[],
  verbose = false
): Promise<number> {
  const state = readState();
  ensureProfile(state, profileName);
  const home = getProfileProviderHome(state, profileName, provider.id);
  writeState(state);

  const bin = requireExecutable(provider);

  if (verbose) {
    console.error(`[amux] provider=${provider.id} profile=${profileName} ${provider.envKey}=${home}`);
  }

  const child = execa(bin, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      [provider.envKey]: home
    }
  });

  try {
    await child;
    return 0;
  } catch (error) {
    const execaError = error as { exitCode?: number };
    return execaError.exitCode ?? 1;
  }
}

function codexStatusFromAuthFile(codexHome: string): ProviderStatus {
  const authFile = path.join(codexHome, 'auth.json');
  const available = findExecutable('codex') !== null;

  if (!fs.existsSync(authFile)) {
    return { available, loggedIn: false };
  }

  try {
    const raw = fs.readFileSync(authFile, 'utf8');
    const parsed = JSON.parse(raw) as {
      tokens?: { account_id?: string };
      auth_mode?: string;
    };

    return {
      available,
      loggedIn: true,
      accountId: parsed.tokens?.account_id,
      authMethod: parsed.auth_mode
    };
  } catch {
    return {
      available,
      loggedIn: true,
      message: 'auth file exists but could not be parsed'
    };
  }
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function claudeStatusFromCli(claudeConfigDir: string): Promise<ProviderStatus> {
  const bin = findExecutable('claude');
  if (!bin) {
    return {
      available: false,
      message: '`claude` not found'
    };
  }

  try {
    const result = await execa(bin, ['auth', 'status', '--json'], {
      reject: false,
      timeout: 7000,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: claudeConfigDir
      }
    });

    if (!result.stdout) {
      return {
        available: true,
        message: 'empty status output'
      };
    }

    const parsed = JSON.parse(result.stdout) as {
      loggedIn?: boolean;
      authMethod?: string;
    };

    return {
      available: true,
      loggedIn: typeof parsed.loggedIn === 'boolean' ? parsed.loggedIn : undefined,
      authMethod: typeof parsed.authMethod === 'string' ? parsed.authMethod : undefined
    };
  } catch (error) {
    return {
      available: true,
      message: formatUnknownError(error)
    };
  }
}

const PROVIDERS: ProviderDefinition[] = [
  {
    id: 'codex',
    label: 'Codex',
    binary: 'codex',
    envKey: 'CODEX_HOME',
    homeDirName: 'codex-home',
    loginArgs: ['login'],
    logoutArgs: ['logout'],
    getStatus: async (homeDir: string) => codexStatusFromAuthFile(homeDir)
  },
  {
    id: 'claude',
    label: 'Claude',
    binary: 'claude',
    envKey: 'CLAUDE_CONFIG_DIR',
    homeDirName: 'claude-config',
    loginArgs: ['auth', 'login'],
    logoutArgs: ['auth', 'logout'],
    getStatus: claudeStatusFromCli
  }
];

const PROVIDER_BY_ID = new Map(PROVIDERS.map((provider) => [provider.id, provider]));

function statusToken(provider: ProviderDefinition, status: ProviderStatus): string {
  if (!status.available) {
    return `${provider.id}:no-cli`;
  }

  if (typeof status.loggedIn === 'boolean') {
    let token = `${provider.id}:${status.loggedIn ? 'in' : 'out'}`;
    if (status.accountId) {
      token += `:${status.accountId}`;
    }
    if (status.authMethod) {
      token += `(${status.authMethod})`;
    }
    return token;
  }

  return `${provider.id}:unknown`;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function registerProviderCommands(
  program: Command,
  provider: ProviderDefinition,
  commonProfileOption: Option,
  commonVerboseOption: Option
): void {
  const cmd = program.command(provider.id).description(`${provider.label} commands`);

  cmd
    .command('login')
    .description(`run ${provider.id} login for selected profile`)
    .allowUnknownOption(true)
    .addOption(commonProfileOption)
    .addOption(commonVerboseOption)
    .argument('[providerArgs...]', 'extra args forwarded to provider login command')
    .action(async (providerArgs: string[], options: CommonOptions) => {
      const state = readState();
      const profile = resolveProfile(state, options);
      writeState(state);

      const exitCode = await runProviderWithProfile(profile, provider, [...provider.loginArgs, ...providerArgs], options.verbose);
      process.exitCode = exitCode;
    });

  cmd
    .command('logout')
    .description(`run ${provider.id} logout for selected profile`)
    .allowUnknownOption(true)
    .addOption(commonProfileOption)
    .addOption(commonVerboseOption)
    .argument('[providerArgs...]', 'extra args forwarded to provider logout command')
    .action(async (providerArgs: string[], options: CommonOptions) => {
      const state = readState();
      const profile = resolveProfile(state, options);
      writeState(state);

      const exitCode = await runProviderWithProfile(profile, provider, [...provider.logoutArgs, ...providerArgs], options.verbose);
      process.exitCode = exitCode;
    });

  cmd
    .command('run')
    .description(`run ${provider.id} with selected profile context (supports \`amux ${provider.id} run <profile>\`)`)
    .allowUnknownOption(true)
    .addOption(commonProfileOption)
    .addOption(commonVerboseOption)
    .argument('[profileOrProviderArgs...]', 'optional profile shortcut + args forwarded to provider CLI')
    .action(async (providerArgs: string[], options: CommonOptions) => {
      const state = readState();
      const resolved = resolveRunProfileAndArgs(state, options, providerArgs);
      writeState(state);

      const exitCode = await runProviderWithProfile(resolved.profile, provider, resolved.providerArgs, options.verbose);
      process.exitCode = exitCode;
    });

  cmd
    .command('status')
    .description(`show ${provider.id} auth status for selected profile`)
    .addOption(commonProfileOption)
    .addOption(new Option('--json', 'output as JSON'))
    .addOption(commonVerboseOption)
    .action(async (options: CommonOptions) => {
      const state = readState();
      const profile = resolveProfile(state, options);
      ensureProfile(state, profile);
      const home = getProfileProviderHome(state, profile, provider.id);
      writeState(state);

      const status = await provider.getStatus(home);

      if (options.json) {
        printJson({
          provider: provider.id,
          profile,
          home,
          status
        });
        return;
      }

      const summary = statusToken(provider, status);
      if (options.verbose) {
        const detail = status.message ? ` detail=${status.message}` : '';
        console.log(`${summary} ${provider.envKey}=${home}${detail}`);
      } else {
        console.log(summary);
      }

      if (!status.available) {
        process.exitCode = 1;
      }
    });
}

async function main(): Promise<void> {
  const program = new Command();

  const commonProfileOption = new Option('-p, --profile <name>', 'profile name');
  const commonVerboseOption = new Option('--verbose', 'show debug details');

  program
    .name('amux')
    .description('amux: extensible multi-profile wrapper for AI agent CLIs')
    .version('0.1.0');

  program
    .command('providers')
    .description('list built-in provider definitions')
    .addOption(new Option('--json', 'output as JSON'))
    .action((options: CommonOptions) => {
      const rows = PROVIDERS.map((provider) => ({
        id: provider.id,
        label: provider.label,
        binary: provider.binary,
        envKey: provider.envKey,
        homeDirName: provider.homeDirName
      }));

      if (options.json) {
        printJson(rows);
        return;
      }

      for (const row of rows) {
        console.log(`${row.id} (${row.binary}) env:${row.envKey} dir:${row.homeDirName}`);
      }
    });

  program
    .command('use <profile>')
    .description('set active profile for this terminal session (or globally)')
    .addOption(new Option('--global', 'set global default profile'))
    .addOption(new Option('--json', 'output as JSON'))
    .addOption(commonVerboseOption)
    .action((profileArg: string, options: CommonOptions) => {
      const profile = sanitizeProfile(profileArg);
      const state = readState();
      ensureProfile(state, profile);

      const sessionKey = getSessionKey();
      if (options.global) {
        state.globalProfile = profile;
      } else {
        state.sessionProfiles[sessionKey] = profile;
      }

      writeState(state);

      const homes = getProviderHomes(state, profile);
      if (options.json) {
        printJson({
          ok: true,
          profile,
          scope: options.global ? 'global' : 'session',
          sessionKey: options.global ? undefined : sessionKey,
          homes,
          codexHome: homes.codex,
          claudeConfigDir: homes.claude
        });
        return;
      }

      if (options.verbose) {
        console.log(`profile=${profile}`);
        console.log(`scope=${options.global ? 'global' : 'session'}`);
        console.log(`session=${sessionKey}`);
        for (const provider of PROVIDERS) {
          console.log(`${provider.envKey}=${homes[provider.id]}`);
        }
        return;
      }

      console.log(profile);
    });

  program
    .command('current')
    .description('show active profile for this terminal')
    .addOption(commonProfileOption)
    .addOption(new Option('--json', 'output as JSON'))
    .addOption(commonVerboseOption)
    .action((options: CommonOptions) => {
      const state = readState();
      const sessionKey = getSessionKey();
      const profile = resolveProfile(state, options);
      const homes = getProviderHomes(state, profile);
      writeState(state);

      if (options.json) {
        printJson({
          profile,
          homes,
          codexHome: homes.codex,
          claudeConfigDir: homes.claude,
          from: options.profile ? 'option' : state.sessionProfiles[sessionKey] ? 'session' : 'global',
          sessionKey
        });
        return;
      }

      if (options.verbose) {
        console.log(`profile=${profile}`);
        console.log(`session=${sessionKey}`);
        for (const provider of PROVIDERS) {
          console.log(`${provider.envKey}=${homes[provider.id]}`);
        }
        return;
      }

      console.log(profile);
    });

  program
    .command('list')
    .description('list profiles and provider auth status')
    .addOption(new Option('--json', 'output as JSON'))
    .addOption(commonVerboseOption)
    .action(async (options: CommonOptions) => {
      const state = readState();
      const sessionKey = getSessionKey();
      const activeSession = state.sessionProfiles[sessionKey];

      const names = Object.keys(state.profiles).sort();
      const rows = await Promise.all(
        names.map(async (profileName) => {
          ensureProfile(state, profileName);

          const providerEntries = await Promise.all(
            PROVIDERS.map(async (provider) => {
              const home = getProfileProviderHome(state, profileName, provider.id);
              const status = await provider.getStatus(home);
              return [provider.id, { home, status }] as const;
            })
          );

          const providers = Object.fromEntries(providerEntries) as Record<string, { home: string; status: ProviderStatus }>;

          return {
            profile: profileName,
            sessionActive: activeSession === profileName,
            globalDefault: state.globalProfile === profileName,
            providers
          };
        })
      );

      writeState(state);

      if (options.json) {
        printJson({
          sessionKey,
          activeSession,
          globalProfile: state.globalProfile,
          profiles: rows
        });
        return;
      }

      if (rows.length === 0) {
        console.log('No profiles yet. Run `amux use <profile>` first.');
        return;
      }

      for (const row of rows) {
        const tags: string[] = [];
        if (row.sessionActive) {
          tags.push('session');
        }
        if (row.globalDefault) {
          tags.push('global');
        }

        const tagText = tags.length > 0 ? ` [${tags.join(',')}]` : '';
        const statusText = PROVIDERS.map((provider) => {
          return statusToken(provider, row.providers[provider.id].status);
        }).join(' ');

        const base = `${row.profile}${tagText} ${statusText}`;

        if (options.verbose) {
          const homes = PROVIDERS.map((provider) => {
            return `${provider.envKey}=${row.providers[provider.id].home}`;
          }).join(' ');
          console.log(`${base} ${homes}`);
        } else {
          console.log(base);
        }
      }
    });

  for (const provider of PROVIDERS) {
    registerProviderCommands(program, provider, commonProfileOption, commonVerboseOption);
  }

  // Backward-compatible aliases from codex-mux
  const codexProvider = PROVIDER_BY_ID.get('codex');
  if (!codexProvider) {
    throw new Error('Missing built-in codex provider definition.');
  }

  program
    .command('login')
    .description('[legacy] same as `amux codex login`')
    .allowUnknownOption(true)
    .addOption(commonProfileOption)
    .addOption(commonVerboseOption)
    .argument('[codexArgs...]', 'extra args forwarded to codex login')
    .action(async (codexArgs: string[], options: CommonOptions) => {
      const state = readState();
      const profile = resolveProfile(state, options);
      writeState(state);
      const exitCode = await runProviderWithProfile(profile, codexProvider, [...codexProvider.loginArgs, ...codexArgs], options.verbose);
      process.exitCode = exitCode;
    });

  program
    .command('logout')
    .description('[legacy] same as `amux codex logout`')
    .allowUnknownOption(true)
    .addOption(commonProfileOption)
    .addOption(commonVerboseOption)
    .argument('[codexArgs...]', 'extra args forwarded to codex logout')
    .action(async (codexArgs: string[], options: CommonOptions) => {
      const state = readState();
      const profile = resolveProfile(state, options);
      writeState(state);
      const exitCode = await runProviderWithProfile(profile, codexProvider, [...codexProvider.logoutArgs, ...codexArgs], options.verbose);
      process.exitCode = exitCode;
    });

  program
    .command('run')
    .description('[legacy] same as `amux codex run` (supports `amux run <profile>`)')
    .allowUnknownOption(true)
    .addOption(commonProfileOption)
    .addOption(commonVerboseOption)
    .argument('[profileOrCodexArgs...]', 'optional profile shortcut + args forwarded to codex')
    .action(async (codexArgs: string[], options: CommonOptions) => {
      const state = readState();
      const resolved = resolveRunProfileAndArgs(state, options, codexArgs);
      writeState(state);
      const exitCode = await runProviderWithProfile(
        resolved.profile,
        codexProvider,
        resolved.providerArgs,
        options.verbose
      );
      process.exitCode = exitCode;
    });

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});
