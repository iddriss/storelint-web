/**
 * The intake form on the client order page: what the team needs to start, minus anything secret.
 * Access is granted by inviting the team's address to the repo and the store consoles, so the
 * form refuses input that looks like a credential instead of storing it.
 */

export const FRAMEWORKS = ['flutter', 'react-native', 'expo', 'other'] as const;
export type FrameworkChoice = (typeof FRAMEWORKS)[number];
export const FRAMEWORK_LABELS: Record<FrameworkChoice, string> = {
  flutter: 'Flutter',
  'react-native': 'React Native',
  expo: 'Expo',
  other: 'Other',
};

export const CODE_SHARES = ['github', 'gitlab', 'zip', 'other'] as const;
export type CodeShare = (typeof CODE_SHARES)[number];
export const CODE_SHARE_LABELS: Record<CodeShare, string> = {
  github: 'GitHub invite',
  gitlab: 'GitLab invite',
  zip: 'Zip upload link',
  other: 'Other (explain in the notes)',
};

export const ACCOUNT_STATES = ['yes', 'no', 'na'] as const;
export type AccountState = (typeof ACCOUNT_STATES)[number];
export const ACCOUNT_STATE_LABELS: Record<AccountState, string> = {
  yes: 'Yes, it exists',
  no: 'Not yet',
  na: 'Not needed for this order',
};

export type IntakePlatform = 'android' | 'ios';

export interface IntakeAnswers {
  app_name: string;
  framework: FrameworkChoice;
  platforms: IntakePlatform[];
  code_share: CodeShare;
  repo_url: string;
  store_urls: string;
  play_account: AccountState;
  apple_account: AccountState;
  /** YYYY-MM-DD or empty. */
  target_date: string;
  notes: string;
}

/** Raw form values, kept as strings so a rejected submission can be re-rendered as typed. */
export interface IntakeFormValues {
  app_name: string;
  framework: string;
  platform_android: boolean;
  platform_ios: boolean;
  code_share: string;
  repo_url: string;
  store_urls: string;
  play_account: string;
  apple_account: string;
  target_date: string;
  notes: string;
}

export type IntakeField = keyof IntakeFormValues | 'platforms';
export type IntakeErrors = Partial<Record<IntakeField, string>>;

export type IntakeValidation = { ok: true; intake: IntakeAnswers } | { ok: false; errors: IntakeErrors; values: IntakeFormValues };

// ---- secret detection ----------------------------------------------------------

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/, 'a private key'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/, 'a GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, 'a GitHub token'],
  [/\bglpat-[A-Za-z0-9_-]{16,}/, 'a GitLab token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key'],
  [/\bAIza[0-9A-Za-z_-]{30,}/, 'a Google API key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/, 'a payment API key'],
  [/\bsk-[A-Za-z0-9_-]{20,}/, 'an API key'],
  [/\bFLWSECK[-_][A-Za-z0-9_-]{10,}/i, 'a Flutterwave secret key'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/, 'a signed token'],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i, 'a link with a password in it'],
];

const PASSWORD_PHRASE = /(?:^|[^a-z])(?:password|passwd|passphrase|pwd)\s*(?:is\s+|[:=]\s*)(\S{6,})/gi;
const PASSWORD_MANAGERS = /^(1password|bitwarden|lastpass|keepass|dashlane|proton)/i;
const URL_RE = /\bhttps?:\/\/\S+/gi;
const TOKEN_RUN = /[A-Za-z0-9+/_-]{32,}={0,2}/g;

/**
 * Returns a short description ("a GitHub token") when `text` looks like it carries a credential,
 * otherwise undefined. Deliberately conservative: links, commit hashes and ordinary prose pass.
 */
export function findSecret(text: string): string | undefined {
  if (!text) return undefined;
  for (const [re, what] of SECRET_PATTERNS) if (re.test(text)) return what;

  for (const m of text.matchAll(PASSWORD_PHRASE)) {
    const value = m[1] ?? '';
    if (/[^A-Za-z]/.test(value) && !PASSWORD_MANAGERS.test(value)) return 'a password';
  }

  // Long token-shaped strings outside of links: base64-ish with mixed case and digits, or long hex.
  for (const run of text.replace(URL_RE, ' ').match(TOKEN_RUN) ?? []) {
    const body = run.replace(/=+$/, '');
    const hex = /^[0-9a-f]+$/.test(body) || /^[0-9A-F]+$/.test(body);
    if (hex) {
      if (body.length !== 40 && /\d/.test(body) && /[a-fA-F]/.test(body)) return 'a long key or token'; // 40 hex = a git commit
      continue;
    }
    if (/[a-z]/.test(body) && /[A-Z]/.test(body) && /\d/.test(body)) return 'a long key or token';
  }
  return undefined;
}

export function secretMessage(what: string, team: string): string {
  return `This looks like it contains ${what}. Please remove it: we never need secrets here. Invite ${team} to the repo and store consoles instead.`;
}

// ---- validation ----------------------------------------------------------------

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim().slice(0, max) : '';
}

function checked(v: unknown): boolean {
  return typeof v === 'string' && v !== '' && v !== '0' && v !== 'false';
}

function isOneOf<T extends string>(list: readonly T[], v: string): v is T {
  return (list as readonly string[]).includes(v);
}

function validDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export function validateIntake(input: Record<string, unknown>, o: { team: string }): IntakeValidation {
  const values: IntakeFormValues = {
    app_name: str(input.app_name, 120),
    framework: str(input.framework, 32),
    platform_android: checked(input.platform_android),
    platform_ios: checked(input.platform_ios),
    code_share: str(input.code_share, 32),
    repo_url: str(input.repo_url, 500),
    store_urls: str(input.store_urls, 2000),
    play_account: str(input.play_account, 8) || 'na',
    apple_account: str(input.apple_account, 8) || 'na',
    target_date: str(input.target_date, 10),
    notes: str(input.notes, 5000),
  };
  const errors: IntakeErrors = {};

  if (!values.app_name) errors.app_name = 'Tell us the app name.';
  if (!isOneOf(FRAMEWORKS, values.framework)) errors.framework = 'Pick the framework.';
  if (!values.platform_android && !values.platform_ios) errors.platforms = 'Pick at least one platform.';
  if (!isOneOf(CODE_SHARES, values.code_share)) errors.code_share = 'Pick how you will share the code.';
  if (values.repo_url && !/^https?:\/\/[^\s/]+\S*$/i.test(values.repo_url)) errors.repo_url = 'Links must start with http:// or https://.';
  else if (!values.repo_url && values.code_share !== 'other' && !errors.code_share) errors.repo_url = 'Add the repository or upload link.';
  if (!isOneOf(ACCOUNT_STATES, values.play_account)) errors.play_account = 'Pick one of the options.';
  if (!isOneOf(ACCOUNT_STATES, values.apple_account)) errors.apple_account = 'Pick one of the options.';
  if (values.target_date && !validDate(values.target_date)) errors.target_date = 'Use a date like 2026-11-30.';

  // Secrets are refused field by field so the message lands next to the offending input.
  for (const field of ['app_name', 'repo_url', 'store_urls', 'notes'] as const) {
    const what = findSecret(values[field]);
    if (what) errors[field] = secretMessage(what, o.team);
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors, values };
  const platforms: IntakePlatform[] = [];
  if (values.platform_android) platforms.push('android');
  if (values.platform_ios) platforms.push('ios');
  return {
    ok: true,
    intake: {
      app_name: values.app_name,
      framework: values.framework as FrameworkChoice,
      platforms,
      code_share: values.code_share as CodeShare,
      repo_url: values.repo_url,
      store_urls: values.store_urls,
      play_account: values.play_account as AccountState,
      apple_account: values.apple_account as AccountState,
      target_date: values.target_date,
      notes: values.notes,
    },
  };
}

/** Reads stored answers back. Tolerates rows written by an older shape. */
export function parseIntake(json: string | null | undefined): IntakeAnswers | undefined {
  if (!json) return undefined;
  try {
    const raw = JSON.parse(json) as Partial<IntakeAnswers> | null;
    if (!raw || typeof raw !== 'object') return undefined;
    const s = (v: unknown) => (typeof v === 'string' ? v : '');
    return {
      app_name: s(raw.app_name),
      framework: isOneOf(FRAMEWORKS, s(raw.framework)) ? (raw.framework as FrameworkChoice) : 'other',
      platforms: Array.isArray(raw.platforms) ? raw.platforms.filter((p): p is IntakePlatform => p === 'android' || p === 'ios') : [],
      code_share: isOneOf(CODE_SHARES, s(raw.code_share)) ? (raw.code_share as CodeShare) : 'other',
      repo_url: s(raw.repo_url),
      store_urls: s(raw.store_urls),
      play_account: isOneOf(ACCOUNT_STATES, s(raw.play_account)) ? (raw.play_account as AccountState) : 'na',
      apple_account: isOneOf(ACCOUNT_STATES, s(raw.apple_account)) ? (raw.apple_account as AccountState) : 'na',
      target_date: s(raw.target_date),
      notes: s(raw.notes),
    };
  } catch {
    return undefined;
  }
}

export function intakeToFormValues(i: IntakeAnswers): IntakeFormValues {
  return {
    app_name: i.app_name,
    framework: i.framework,
    platform_android: i.platforms.includes('android'),
    platform_ios: i.platforms.includes('ios'),
    code_share: i.code_share,
    repo_url: i.repo_url,
    store_urls: i.store_urls,
    play_account: i.play_account,
    apple_account: i.apple_account,
    target_date: i.target_date,
    notes: i.notes,
  };
}

/** Sensible first-visit defaults for a plan (nothing is stored until the client submits). */
export function defaultIntakeValues(plan: string): IntakeFormValues {
  const android = plan === 'play' || plan === 'both';
  const ios = plan === 'ios' || plan === 'both';
  return {
    app_name: '',
    framework: '',
    platform_android: android,
    platform_ios: ios,
    code_share: 'github',
    repo_url: '',
    store_urls: '',
    play_account: android ? 'yes' : 'na',
    apple_account: ios ? 'yes' : 'na',
    target_date: '',
    notes: '',
  };
}

/** Label/value pairs for the admin page and the internal notification. */
export function intakeSummary(i: IntakeAnswers): Array<[label: string, value: string]> {
  return [
    ['App name', i.app_name],
    ['Framework', FRAMEWORK_LABELS[i.framework]],
    ['Platforms', i.platforms.map((p) => (p === 'android' ? 'Android' : 'iOS')).join(', ')],
    ['Code shared via', CODE_SHARE_LABELS[i.code_share]],
    ['Repository / upload link', i.repo_url],
    ['Existing store listings', i.store_urls],
    ['Play Console account', ACCOUNT_STATE_LABELS[i.play_account]],
    ['Apple Developer account', ACCOUNT_STATE_LABELS[i.apple_account]],
    ['Target date', i.target_date],
    ['Notes', i.notes],
  ];
}
