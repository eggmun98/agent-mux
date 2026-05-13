#!/usr/bin/env node

import { Command, Option } from 'commander';
import { execa } from 'execa';
import fs from 'node:fs';
import * as http from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
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

type MuxConfig = {
  defaultProvider?: ProviderId;
};

type MuxState = {
  version: number;
  config: MuxConfig;
  globalProfile?: ProfileName;
  sessionProfiles: Record<string, ProfileName>;
  profiles: Record<ProfileName, ProfileState>;
};

type CommonOptions = {
  profile?: string;
  provider?: string;
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

type ProviderStatusEntry = {
  id: ProviderId;
  label: string;
  binary: string;
  binaryPath: string | null;
  envKey: string;
  home: string;
  status: ProviderStatus;
};

type LocalCallbackForwardResult = {
  statusCode: number;
  statusMessage: string;
  finalUrl: string;
  redirects: string[];
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

const CLI_VERSION = '0.1.3';
const STATE_VERSION = 4;

const DEFAULT_AMUX_HOME = path.join(homedir(), '.amux');
const MUX_HOME = resolveMuxHome();
const STATE_FILE = path.join(MUX_HOME, 'state.json');
const STATE_BACKUP_FILE = path.join(MUX_HOME, 'state.backup.json');
const PROFILES_DIR = path.join(MUX_HOME, 'profiles');
const PROFILES_TRASH_DIR = path.join(PROFILES_DIR, '.trash');

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

function normalizeConfig(input: unknown): MuxConfig {
  const source = asObject(input);
  if (!source) {
    return {};
  }

  const config: MuxConfig = {};
  const defaultProvider = source.defaultProvider;
  if (typeof defaultProvider === 'string') {
    const provider = findProvider(defaultProvider);
    if (provider) {
      config.defaultProvider = provider.id;
    }
  }

  return config;
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
    config: {},
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
    config: normalizeConfig(source.config),
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

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function pathIsInsideOrEqual(parent: string, target: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function rebaseProfileHomePath(home: string, fromProfile: string, toProfile: string): string {
  const fromDir = path.join(PROFILES_DIR, fromProfile);
  const toDir = path.join(PROFILES_DIR, toProfile);
  if (!pathIsInsideOrEqual(fromDir, home)) {
    return home;
  }

  return path.join(toDir, path.relative(fromDir, home));
}

function timestampForPath(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function uniquePath(basePath: string): string {
  if (!fs.existsSync(basePath)) {
    return basePath;
  }

  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${basePath}-${index}`;
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Could not allocate a unique archive path for ${basePath}.`);
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

function providerLegacyHomeKey(provider: ProviderDefinition): string | undefined {
  if (provider.id === 'codex') {
    return 'codexHome';
  }
  if (provider.id === 'claude') {
    return 'claudeConfigDir';
  }
  if (provider.id === 'gemini') {
    return 'geminiCliHome';
  }
  return undefined;
}

function providerHomeLegacyFields(homes: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};

  for (const provider of PROVIDERS) {
    const legacyKey = providerLegacyHomeKey(provider);
    if (legacyKey && homes[provider.id]) {
      result[legacyKey] = homes[provider.id];
    }
  }

  return result;
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

function resolveActiveProfileInfo(
  state: MuxState,
  options: CommonOptions
): { profile?: string; from?: 'option' | 'session' | 'global'; sessionKey: string } {
  const sessionKey = getSessionKey();

  if (options.profile) {
    const profile = sanitizeProfile(options.profile);
    ensureProfile(state, profile);
    return { profile, from: 'option', sessionKey };
  }

  const sessionProfile = state.sessionProfiles[sessionKey];
  if (sessionProfile) {
    ensureProfile(state, sessionProfile);
    return { profile: sessionProfile, from: 'session', sessionKey };
  }

  if (state.globalProfile) {
    ensureProfile(state, state.globalProfile);
    return { profile: state.globalProfile, from: 'global', sessionKey };
  }

  return { sessionKey };
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

function isLocalCallbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized === '[::1]';
}

function parseLocalCallbackUrl(rawUrl: string): URL {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error('Redirect URL cannot be empty.');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Redirect URL must be a valid URL.');
  }

  if (parsed.protocol !== 'http:') {
    throw new Error('Only http:// localhost redirect URLs are allowed.');
  }

  if (!isLocalCallbackHost(parsed.hostname)) {
    throw new Error('Only localhost, 127.0.0.1, or ::1 redirect URLs are allowed.');
  }

  if (!parsed.port) {
    throw new Error('Redirect URL must include the Codex local callback port.');
  }

  return parsed;
}

function redactedLocalUrl(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}`;
}

async function readAllStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      resolve(data);
    });
    process.stdin.on('error', reject);
  });
}

async function readCallbackUrl(urlArg?: string): Promise<string> {
  if (urlArg?.trim()) {
    return urlArg.trim();
  }

  if (process.stdin.isTTY) {
    const readline = createInterface({
      input: process.stdin,
      output: process.stdout
    });

    try {
      return (await readline.question('Paste localhost redirect URL: ')).trim();
    } finally {
      readline.close();
    }
  }

  return (await readAllStdin()).trim();
}

type SelectionChoice<T> = {
  id: string;
  label: string;
  value: T;
  detail?: string;
};

function matchSelection<T>(input: string, choices: SelectionChoice<T>[]): T | undefined {
  const answer = input.trim();
  if (!answer) {
    return undefined;
  }

  if (/^\d+$/.test(answer)) {
    const index = Number.parseInt(answer, 10) - 1;
    return choices[index]?.value;
  }

  const normalized = answer.toLowerCase();
  return choices.find((choice) => {
    return choice.id.toLowerCase() === normalized || choice.label.toLowerCase() === normalized;
  })?.value;
}

async function readSelectionInput(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const input = await readAllStdin();
    const firstLine = input
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return firstLine ?? '';
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    return await readline.question(prompt);
  } finally {
    readline.close();
  }
}

async function selectFromChoices<T>(
  title: string,
  choices: SelectionChoice<T>[],
  options: { emptyInputValue?: T } = {}
): Promise<T> {
  if (choices.length === 0) {
    throw new Error('No selectable entries are available.');
  }

  if (process.stdin.isTTY) {
    for (const [index, choice] of choices.entries()) {
      const detail = choice.detail ? ` - ${choice.detail}` : '';
      console.log(`${index + 1}. ${choice.label}${detail}`);
    }
  }

  const answer = await readSelectionInput(`${title}: `);
  const matched = matchSelection(answer, choices);
  if (matched !== undefined) {
    return matched;
  }

  if (!answer.trim() && options.emptyInputValue !== undefined) {
    return options.emptyInputValue;
  }

  throw new Error(`Invalid selection: ${answer || '(empty)'}`);
}

async function requestLocalCallback(url: URL): Promise<{
  statusCode: number;
  statusMessage: string;
  location?: string;
}> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: 'GET' }, (response) => {
      response.resume();
      response.on('end', () => {
        const rawLocation = response.headers.location;
        const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;
        resolve({
          statusCode: response.statusCode ?? 0,
          statusMessage: response.statusMessage ?? '',
          location
        });
      });
    });

    request.setTimeout(10_000, () => {
      request.destroy(new Error('Timed out while forwarding redirect URL to the local callback server.'));
    });
    request.on('error', reject);
    request.end();
  });
}

async function forwardLocalCallback(rawUrl: string): Promise<LocalCallbackForwardResult> {
  let currentUrl = parseLocalCallbackUrl(rawUrl);
  const redirects: string[] = [];

  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    const response = await requestLocalCallback(currentUrl);
    const shouldFollow =
      response.statusCode >= 300 && response.statusCode < 400 && Boolean(response.location) && redirectCount < 5;

    if (!shouldFollow) {
      return {
        statusCode: response.statusCode,
        statusMessage: response.statusMessage,
        finalUrl: redactedLocalUrl(currentUrl),
        redirects
      };
    }

    const nextUrl = parseLocalCallbackUrl(new URL(response.location as string, currentUrl).toString());
    redirects.push(redactedLocalUrl(nextUrl));
    currentUrl = nextUrl;
  }

  throw new Error('Too many redirects while forwarding the local callback URL.');
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

async function geminiStatusFromHome(geminiHome: string): Promise<ProviderStatus> {
  const available = findExecutable('gemini') !== null;
  if (!available) {
    return {
      available: false,
      message: '`gemini` not found'
    };
  }

  const geminiDir = path.join(geminiHome, '.gemini');
  const oauthFile = path.join(geminiDir, 'oauth_creds.json');
  const accountsFile = path.join(geminiDir, 'google_accounts.json');

  if (fs.existsSync(oauthFile)) {
    return {
      available: true,
      loggedIn: true,
      authMethod: 'oauth'
    };
  }

  if (fs.existsSync(accountsFile)) {
    return {
      available: true,
      loggedIn: true,
      authMethod: 'google-account'
    };
  }

  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
    return {
      available: true,
      loggedIn: true,
      authMethod: 'api-key-env',
      message: 'API key comes from the shell environment, not this profile home'
    };
  }

  return {
    available: true,
    loggedIn: false
  };
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
    label: 'Claude Code',
    binary: 'claude',
    envKey: 'CLAUDE_CONFIG_DIR',
    homeDirName: 'claude-config',
    loginArgs: ['auth', 'login'],
    logoutArgs: ['auth', 'logout'],
    getStatus: claudeStatusFromCli
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    binary: 'gemini',
    envKey: 'GEMINI_CLI_HOME',
    homeDirName: 'gemini-home',
    loginArgs: [],
    logoutArgs: [],
    getStatus: geminiStatusFromHome
  }
];

const PROVIDER_BY_ID = new Map(PROVIDERS.map((provider) => [provider.id, provider]));

function findProvider(input: string): ProviderDefinition | undefined {
  const normalized = input.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  return PROVIDERS.find((provider) => {
    return (
      provider.id.toLowerCase() === normalized ||
      provider.binary.toLowerCase() === normalized ||
      provider.label.toLowerCase() === normalized
    );
  });
}

function requireKnownProvider(input: string): ProviderDefinition {
  const provider = findProvider(input);
  if (!provider) {
    throw new Error(`Unknown provider: ${input}`);
  }
  return provider;
}

function getDefaultProvider(state: MuxState): ProviderDefinition | undefined {
  if (!state.config.defaultProvider) {
    return undefined;
  }

  return PROVIDER_BY_ID.get(state.config.defaultProvider);
}

function providerSelectionChoices(defaultProvider?: ProviderDefinition): SelectionChoice<ProviderDefinition>[] {
  return PROVIDERS.map((provider) => {
    const available = findExecutable(provider.binary) !== null;
    const details: string[] = [];
    if (defaultProvider?.id === provider.id) {
      details.push('default');
    }
    details.push(available ? provider.binary : `${provider.binary} not found`);

    return {
      id: provider.id,
      label: `${provider.id} (${provider.label})`,
      value: provider,
      detail: details.join(', ')
    };
  });
}

async function resolveProviderForInteractiveAlias(
  state: MuxState,
  options: CommonOptions,
  rawArgs: string[],
  emptyInputProvider: ProviderDefinition
): Promise<{ provider: ProviderDefinition; providerArgs: string[] }> {
  if (options.provider) {
    const provider = requireKnownProvider(options.provider);
    return { provider, providerArgs: rawArgs };
  }

  const firstArg = rawArgs[0];
  if (firstArg && !firstArg.startsWith('-')) {
    const provider = findProvider(firstArg);
    if (provider) {
      return {
        provider,
        providerArgs: rawArgs.slice(1)
      };
    }
  }

  if (firstArg?.startsWith('-')) {
    return {
      provider: emptyInputProvider,
      providerArgs: rawArgs
    };
  }

  const defaultProvider = getDefaultProvider(state);
  const selected = await selectFromChoices('Select provider', providerSelectionChoices(defaultProvider), {
    emptyInputValue: defaultProvider ?? (process.stdin.isTTY ? undefined : emptyInputProvider)
  });

  return {
    provider: selected,
    providerArgs: rawArgs
  };
}

function profileSelectionChoices(state: MuxState): SelectionChoice<string>[] {
  const sessionKey = getSessionKey();
  const names = Object.keys(state.profiles).sort();

  return names.map((profileName) => {
    const tags: string[] = [];
    if (state.sessionProfiles[sessionKey] === profileName) {
      tags.push('session');
    }
    if (state.globalProfile === profileName) {
      tags.push('global');
    }

    return {
      id: profileName,
      label: profileName,
      value: profileName,
      detail: tags.length > 0 ? tags.join(',') : undefined
    };
  });
}

async function resolveUseProfile(state: MuxState, profileArg?: string): Promise<string> {
  if (profileArg) {
    return sanitizeProfile(profileArg);
  }

  const choices = profileSelectionChoices(state);
  if (choices.length === 0) {
    throw new Error('No profiles yet. Run `amux use <profile>` first.');
  }

  return selectFromChoices('Select profile', choices);
}

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

function statusWord(status: ProviderStatus): string {
  if (!status.available) {
    return 'no-cli';
  }

  if (status.loggedIn === true) {
    return 'logged-in';
  }

  if (status.loggedIn === false) {
    return 'logged-out';
  }

  return 'unknown';
}

function statusDetail(status: ProviderStatus): string {
  const details: string[] = [];
  if (status.authMethod) {
    details.push(status.authMethod);
  }
  if (status.accountId) {
    details.push(status.accountId);
  }
  if (status.message) {
    details.push(status.message);
  }
  return details.join(' ');
}

async function collectProviderStatusEntries(state: MuxState, profile: string): Promise<ProviderStatusEntry[]> {
  ensureProfile(state, profile);

  return Promise.all(
    PROVIDERS.map(async (provider) => {
      const home = getProfileProviderHome(state, profile, provider.id);
      const status = await provider.getStatus(home);
      return {
        id: provider.id,
        label: provider.label,
        binary: provider.binary,
        binaryPath: findExecutable(provider.binary),
        envKey: provider.envKey,
        home,
        status
      };
    })
  );
}

function providerStatusMap(entries: ProviderStatusEntry[]): Record<string, Omit<ProviderStatusEntry, 'id'>> {
  return Object.fromEntries(
    entries.map((entry) => {
      const { id, ...rest } = entry;
      return [id, rest];
    })
  ) as Record<string, Omit<ProviderStatusEntry, 'id'>>;
}

function homesFromStatusEntries(entries: ProviderStatusEntry[]): Record<string, string> {
  return Object.fromEntries(entries.map((entry) => [entry.id, entry.home])) as Record<string, string>;
}

function printProviderStatusEntries(entries: ProviderStatusEntry[], options: { verbose?: boolean } = {}): void {
  for (const entry of entries) {
    const executable = entry.binaryPath ?? 'not found';
    const detail = statusDetail(entry.status);
    const detailText = detail ? ` ${detail}` : '';

    if (options.verbose) {
      console.log(`${entry.id} ${statusWord(entry.status)} ${executable} ${entry.envKey}=${entry.home}${detailText}`);
    } else {
      console.log(`${entry.id} ${statusWord(entry.status)} ${executable}${detailText}`);
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function rebaseProfileHomes(profileState: ProfileState, fromProfile: string, toProfile: string): ProfileState {
  const next = cloneJson(profileState);

  for (const entry of Object.values(next.providers)) {
    if (typeof entry.home === 'string' && entry.home.trim()) {
      entry.home = rebaseProfileHomePath(entry.home, fromProfile, toProfile);
    }
  }

  ensureKnownProviderHomes(toProfile, next.providers);
  return next;
}

function replaceProfileReferences(state: MuxState, fromProfile: string, toProfile: string): void {
  if (state.globalProfile === fromProfile) {
    state.globalProfile = toProfile;
  }

  for (const [sessionKey, profileName] of Object.entries(state.sessionProfiles)) {
    if (profileName === fromProfile) {
      state.sessionProfiles[sessionKey] = toProfile;
    }
  }
}

function removeProfileReferences(state: MuxState, profileName: string): void {
  if (state.globalProfile === profileName) {
    delete state.globalProfile;
  }

  for (const [sessionKey, selectedProfile] of Object.entries(state.sessionProfiles)) {
    if (selectedProfile === profileName) {
      delete state.sessionProfiles[sessionKey];
    }
  }
}

function renameProfileDirectory(fromProfile: string, toProfile: string): void {
  const fromDir = path.join(PROFILES_DIR, fromProfile);
  const toDir = path.join(PROFILES_DIR, toProfile);

  if (fs.existsSync(toDir)) {
    throw new Error(`Profile directory already exists: ${toDir}`);
  }

  if (fs.existsSync(fromDir)) {
    ensureDir(PROFILES_DIR);
    fs.renameSync(fromDir, toDir);
  }
}

function copyProfileDirectory(fromProfile: string, toProfile: string): void {
  const fromDir = path.join(PROFILES_DIR, fromProfile);
  const toDir = path.join(PROFILES_DIR, toProfile);

  if (fs.existsSync(toDir)) {
    throw new Error(`Profile directory already exists: ${toDir}`);
  }

  if (fs.existsSync(fromDir)) {
    fs.cpSync(fromDir, toDir, {
      recursive: true,
      errorOnExist: true,
      force: false
    });
  } else {
    ensureDir(toDir);
  }
}

function archiveProfileDirectory(profileName: string): string | undefined {
  const profileDir = path.join(PROFILES_DIR, profileName);
  if (!fs.existsSync(profileDir)) {
    return undefined;
  }

  ensureDir(PROFILES_TRASH_DIR);
  const archivePath = uniquePath(path.join(PROFILES_TRASH_DIR, `${profileName}-${timestampForPath()}`));
  fs.renameSync(profileDir, archivePath);
  return archivePath;
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
        if (!status.available) {
          process.exitCode = 1;
        }
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

  if (provider.id === 'codex') {
    cmd
      .command('login-device')
      .description('run codex login with device-code auth for remote/headless machines')
      .allowUnknownOption(true)
      .addOption(commonProfileOption)
      .addOption(commonVerboseOption)
      .argument('[providerArgs...]', 'extra args forwarded to codex login --device-auth')
      .action(async (providerArgs: string[], options: CommonOptions) => {
        const state = readState();
        const profile = resolveProfile(state, options);
        writeState(state);

        const exitCode = await runProviderWithProfile(
          profile,
          provider,
          [...provider.loginArgs, '--device-auth', ...providerArgs],
          options.verbose
        );
        process.exitCode = exitCode;
      });

    cmd
      .command('callback')
      .description('forward a pasted localhost OAuth redirect URL to the running Codex login server')
      .argument('[url]', 'localhost redirect URL copied from the browser address bar')
      .addOption(new Option('--json', 'output as JSON'))
      .action(async (urlArg: string | undefined, options: CommonOptions) => {
        const rawUrl = await readCallbackUrl(urlArg);
        const result = await forwardLocalCallback(rawUrl);
        const ok = result.statusCode >= 200 && result.statusCode < 400;

        if (options.json) {
          printJson({
            ok,
            statusCode: result.statusCode,
            statusMessage: result.statusMessage,
            finalUrl: result.finalUrl,
            redirects: result.redirects
          });
        } else {
          const statusText = result.statusMessage ? `${result.statusCode} ${result.statusMessage}` : result.statusCode;
          console.log(`forwarded ${result.finalUrl} status=${statusText}`);
          if (result.redirects.length > 0) {
            console.log(`followed ${result.redirects.length} localhost redirect(s)`);
          }
        }

        if (!ok) {
          process.exitCode = 1;
        }
      });
  }
}

async function main(): Promise<void> {
  const program = new Command();

  const commonProfileOption = new Option('-p, --profile <name>', 'profile name');
  const commonProviderOption = new Option('--provider <id>', 'provider id');
  const commonVerboseOption = new Option('--verbose', 'show debug details');

  program
    .name('amux')
    .description('amux: extensible multi-profile wrapper for AI agent CLIs')
    .version(CLI_VERSION);

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
    .command('use [profile]')
    .description('set active profile for this terminal session (or choose one interactively)')
    .addOption(new Option('--global', 'set global default profile'))
    .addOption(new Option('--json', 'output as JSON'))
    .addOption(commonVerboseOption)
    .action(async (profileArg: string | undefined, options: CommonOptions) => {
      const state = readState();
      const profile = await resolveUseProfile(state, profileArg);
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
          ...providerHomeLegacyFields(homes)
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
          ...providerHomeLegacyFields(homes),
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

  program
    .command('status')
    .description('show all provider auth status for selected profile')
    .addOption(commonProfileOption)
    .addOption(new Option('--json', 'output as JSON'))
    .addOption(commonVerboseOption)
    .action(async (options: CommonOptions) => {
      const state = readState();
      const active = resolveActiveProfileInfo(state, options);
      if (!active.profile) {
        throw new Error('No active profile. Run `amux use <profile>` first.');
      }

      const entries = await collectProviderStatusEntries(state, active.profile);
      writeState(state);

      if (options.json) {
        const homes = homesFromStatusEntries(entries);
        if (entries.some((entry) => !entry.status.available)) {
          process.exitCode = 1;
        }
        printJson({
          profile: active.profile,
          from: active.from,
          sessionKey: active.sessionKey,
          homes,
          ...providerHomeLegacyFields(homes),
          providers: providerStatusMap(entries)
        });
        return;
      }

      console.log(`profile=${active.profile}`);
      printProviderStatusEntries(entries, { verbose: options.verbose });

      if (entries.some((entry) => !entry.status.available)) {
        process.exitCode = 1;
      }
    });

  program
    .command('doctor')
    .description('diagnose amux, profile, provider CLI, and auth state')
    .addOption(commonProfileOption)
    .addOption(new Option('--json', 'output as JSON'))
    .addOption(commonVerboseOption)
    .action(async (options: CommonOptions) => {
      const state = readState();
      const active = resolveActiveProfileInfo(state, options);
      const defaultProvider = getDefaultProvider(state);
      const issues: string[] = [];
      let entries: ProviderStatusEntry[] = [];

      if (active.profile) {
        entries = await collectProviderStatusEntries(state, active.profile);
        for (const entry of entries) {
          if (!entry.status.available) {
            issues.push(`${entry.id}: ${entry.binary} not found in PATH`);
          }
        }
        writeState(state);
      } else {
        for (const provider of PROVIDERS) {
          if (!findExecutable(provider.binary)) {
            issues.push(`${provider.id}: ${provider.binary} not found in PATH`);
          }
        }
        issues.push('No active profile. Run `amux use <profile>` first.');
      }

      if (state.config.defaultProvider && !defaultProvider) {
        issues.push(`Configured default provider is unknown: ${state.config.defaultProvider}`);
      }

      if (options.json) {
        const homes = active.profile ? homesFromStatusEntries(entries) : {};
        if (issues.length > 0) {
          process.exitCode = 1;
        }
        printJson({
          ok: issues.length === 0,
          version: CLI_VERSION,
          amuxHome: MUX_HOME,
          stateFile: STATE_FILE,
          sessionKey: active.sessionKey,
          profile: active.profile,
          profileFrom: active.from,
          defaultProvider: defaultProvider?.id,
          profileCount: Object.keys(state.profiles).length,
          homes,
          providers: active.profile ? providerStatusMap(entries) : undefined,
          issues
        });
        return;
      }

      console.log(`amux=${CLI_VERSION}`);
      console.log(`home=${MUX_HOME}`);
      console.log(`state=${STATE_FILE}`);
      console.log(`session=${active.sessionKey}`);
      console.log(`profile=${active.profile ? `${active.profile} (${active.from})` : 'none'}`);
      console.log(`default-provider=${defaultProvider?.id ?? 'unset'}`);

      if (active.profile) {
        console.log('providers:');
        printProviderStatusEntries(entries, { verbose: true });
      } else {
        console.log('providers:');
        for (const provider of PROVIDERS) {
          const executable = findExecutable(provider.binary) ?? 'not found';
          console.log(`${provider.id} ${executable}`);
        }
      }

      if (issues.length > 0) {
        console.log('issues:');
        for (const issue of issues) {
          console.log(`- ${issue}`);
        }
        process.exitCode = 1;
      } else if (options.verbose) {
        console.log('issues: none');
      }
    });

  program
    .command('env [provider]')
    .description('print shell exports for selected profile provider homes')
    .addOption(commonProfileOption)
    .addOption(new Option('--json', 'output as JSON'))
    .action((providerArg: string | undefined, options: CommonOptions) => {
      const state = readState();
      const profile = resolveProfile(state, options);
      const selectedProviders = providerArg ? [requireKnownProvider(providerArg)] : PROVIDERS;
      const envValues: Record<string, string> = {};

      for (const provider of selectedProviders) {
        envValues[provider.envKey] = getProfileProviderHome(state, profile, provider.id);
      }

      writeState(state);

      if (options.json) {
        printJson({
          profile,
          env: envValues
        });
        return;
      }

      for (const [key, value] of Object.entries(envValues)) {
        console.log(`export ${key}=${shellQuote(value)}`);
      }
    });

  const profileCmd = program.command('profile').description('manage amux profiles');

  profileCmd
    .command('list')
    .description('list profile names without checking provider auth status')
    .addOption(new Option('--json', 'output as JSON'))
    .action((options: CommonOptions) => {
      const state = readState();
      const sessionKey = getSessionKey();
      const profiles = Object.keys(state.profiles)
        .sort()
        .map((profile) => ({
          profile,
          sessionActive: state.sessionProfiles[sessionKey] === profile,
          globalDefault: state.globalProfile === profile
        }));

      if (options.json) {
        printJson({
          sessionKey,
          globalProfile: state.globalProfile,
          profiles
        });
        return;
      }

      if (profiles.length === 0) {
        console.log('No profiles yet. Run `amux use <profile>` first.');
        return;
      }

      for (const row of profiles) {
        const tags: string[] = [];
        if (row.sessionActive) {
          tags.push('session');
        }
        if (row.globalDefault) {
          tags.push('global');
        }
        console.log(`${row.profile}${tags.length > 0 ? ` [${tags.join(',')}]` : ''}`);
      }
    });

  profileCmd
    .command('rename <from> <to>')
    .description('rename a profile and move its profile directory')
    .addOption(new Option('--json', 'output as JSON'))
    .action((fromArg: string, toArg: string, options: CommonOptions) => {
      const fromProfile = sanitizeProfile(fromArg);
      const toProfile = sanitizeProfile(toArg);
      const state = readState();

      if (!state.profiles[fromProfile]) {
        throw new Error(`Profile not found: ${fromProfile}`);
      }
      if (state.profiles[toProfile]) {
        throw new Error(`Profile already exists: ${toProfile}`);
      }

      ensureProfile(state, fromProfile);
      renameProfileDirectory(fromProfile, toProfile);
      state.profiles[toProfile] = rebaseProfileHomes(state.profiles[fromProfile], fromProfile, toProfile);
      delete state.profiles[fromProfile];
      replaceProfileReferences(state, fromProfile, toProfile);
      writeState(state);

      if (options.json) {
        printJson({ ok: true, from: fromProfile, to: toProfile });
        return;
      }

      console.log(`${fromProfile} -> ${toProfile}`);
    });

  profileCmd
    .command('copy <from> <to>')
    .description('copy a profile and its profile directory')
    .addOption(new Option('--json', 'output as JSON'))
    .action((fromArg: string, toArg: string, options: CommonOptions) => {
      const fromProfile = sanitizeProfile(fromArg);
      const toProfile = sanitizeProfile(toArg);
      const state = readState();

      if (!state.profiles[fromProfile]) {
        throw new Error(`Profile not found: ${fromProfile}`);
      }
      if (state.profiles[toProfile]) {
        throw new Error(`Profile already exists: ${toProfile}`);
      }

      ensureProfile(state, fromProfile);
      copyProfileDirectory(fromProfile, toProfile);
      state.profiles[toProfile] = rebaseProfileHomes(state.profiles[fromProfile], fromProfile, toProfile);
      writeState(state);

      if (options.json) {
        printJson({ ok: true, from: fromProfile, to: toProfile });
        return;
      }

      console.log(`${fromProfile} copied to ${toProfile}`);
    });

  profileCmd
    .command('remove <profile>')
    .description('remove a profile from state and archive its profile directory')
    .addOption(new Option('--json', 'output as JSON'))
    .action((profileArg: string, options: CommonOptions) => {
      const profile = sanitizeProfile(profileArg);
      const state = readState();

      if (!state.profiles[profile]) {
        throw new Error(`Profile not found: ${profile}`);
      }

      const archivePath = archiveProfileDirectory(profile);
      delete state.profiles[profile];
      removeProfileReferences(state, profile);
      writeState(state);

      if (options.json) {
        printJson({
          ok: true,
          profile,
          archivedTo: archivePath
        });
        return;
      }

      console.log(`${profile} removed${archivePath ? ` archived=${archivePath}` : ''}`);
    });

  const configCmd = program.command('config').description('manage amux settings');

  configCmd
    .command('list')
    .description('list configured settings')
    .addOption(new Option('--json', 'output as JSON'))
    .action((options: CommonOptions) => {
      const state = readState();
      const defaultProvider = getDefaultProvider(state);

      if (options.json) {
        printJson({
          defaultProvider: defaultProvider?.id
        });
        return;
      }

      console.log(`default-provider=${defaultProvider?.id ?? 'unset'}`);
    });

  configCmd
    .command('get <key>')
    .description('get a configured setting')
    .addOption(new Option('--json', 'output as JSON'))
    .action((key: string, options: CommonOptions) => {
      const state = readState();
      if (key !== 'default-provider') {
        throw new Error(`Unknown config key: ${key}`);
      }

      const value = getDefaultProvider(state)?.id;
      if (options.json) {
        printJson({ key, value });
        return;
      }

      console.log(value ?? 'unset');
    });

  configCmd
    .command('set <key> <value>')
    .description('set a configured setting')
    .addOption(new Option('--json', 'output as JSON'))
    .action((key: string, value: string, options: CommonOptions) => {
      const state = readState();
      if (key !== 'default-provider') {
        throw new Error(`Unknown config key: ${key}`);
      }

      const provider = requireKnownProvider(value);
      state.config.defaultProvider = provider.id;
      writeState(state);

      if (options.json) {
        printJson({ ok: true, key, value: provider.id });
        return;
      }

      console.log(`${key}=${provider.id}`);
    });

  configCmd
    .command('unset <key>')
    .description('unset a configured setting')
    .addOption(new Option('--json', 'output as JSON'))
    .action((key: string, options: CommonOptions) => {
      const state = readState();
      if (key !== 'default-provider') {
        throw new Error(`Unknown config key: ${key}`);
      }

      delete state.config.defaultProvider;
      writeState(state);

      if (options.json) {
        printJson({ ok: true, key });
        return;
      }

      console.log(`${key}=unset`);
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
    .description('choose a provider and run login for the selected profile')
    .allowUnknownOption(true)
    .addOption(commonProfileOption)
    .addOption(commonProviderOption)
    .addOption(commonVerboseOption)
    .argument('[providerOrArgs...]', 'optional provider id + args forwarded to provider login')
    .action(async (providerOrArgs: string[], options: CommonOptions) => {
      const state = readState();
      const selected = await resolveProviderForInteractiveAlias(state, options, providerOrArgs, codexProvider);
      const profile = resolveProfile(state, options);
      writeState(state);
      const exitCode = await runProviderWithProfile(
        profile,
        selected.provider,
        [...selected.provider.loginArgs, ...selected.providerArgs],
        options.verbose
      );
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
