import type { LeadInput } from './db.js';

export const PLATFORMS = ['play', 'ios', 'both', 'fix', 'unsure', 'deepscan'] as const;
export type PlatformChoice = (typeof PLATFORMS)[number];

export const PLATFORM_LABELS: Record<PlatformChoice, string> = {
  play: 'Google Play ($149)',
  ios: 'App Store ($199)',
  both: 'Both stores ($299)',
  fix: 'Fix a rejection ($99)',
  unsure: 'Not sure yet',
  deepscan: 'Deep scan waitlist',
};

export interface LeadFormValues {
  name: string;
  email: string;
  platform: string;
  store_links: string;
  repo_url: string;
  message: string;
}

export type LeadValidation =
  | { ok: true; lead: Omit<LeadInput, 'ip'>; spam: boolean }
  | { ok: false; errors: Partial<Record<keyof LeadFormValues, string>>; values: LeadFormValues };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim().slice(0, max) : '';
}

/** Validates a lead form submission. `website` is a honeypot: bots fill it, people never see it. */
export function validateLead(input: Record<string, unknown>): LeadValidation {
  const values: LeadFormValues = {
    name: str(input.name, 120),
    email: str(input.email, 254),
    platform: str(input.platform, 32),
    store_links: str(input.store_links, 2000),
    repo_url: str(input.repo_url, 500),
    message: str(input.message, 5000),
  };
  const spam = str(input.website, 10).length > 0;
  const errors: Partial<Record<keyof LeadFormValues, string>> = {};

  if (!(PLATFORMS as readonly string[]).includes(values.platform)) errors.platform = 'Pick one of the options.';
  if (values.platform === 'deepscan' && !values.name) values.name = '(deep scan waitlist)';
  if (!values.name) errors.name = 'Tell us who to reply to.';
  if (!values.email || !EMAIL_RE.test(values.email)) errors.email = 'Enter a valid email address.';
  if (values.repo_url && !/^https?:\/\/\S+$/i.test(values.repo_url)) errors.repo_url = 'Repository links must start with http:// or https://.';

  if (Object.keys(errors).length > 0) return { ok: false, errors, values };
  return { ok: true, spam, lead: { ...values } };
}
