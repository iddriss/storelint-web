/**
 * Intake checklist shown after a successful payment. Mirrors the
 * "What you must provide" section of services/release-ops/OFFER.md.
 * (Play) / (Apple) marks items that apply to one store only.
 */
export interface IntakeGroup {
  title: string;
  items: string[];
}

export const INTAKE_CHECKLIST: IntakeGroup[] = [
  {
    title: 'Code and build',
    items: [
      'Repository access (GitHub/GitLab invite) or a zip of the exact commit to ship. For Expo, include app.json / app.config.* and eas.json if you have one.',
      'Any .env or config values needed for a release build, sent through a password manager share or encrypted file, never in chat.',
      'Existing upload keystore and key.properties values if the app is already on Play (Play). For a brand-new app we generate a new upload key and hand it to you.',
      'Which Flutter / React Native / Expo SDK version the app builds with today.',
    ],
  },
  {
    title: 'Accounts and access',
    items: [
      'Play Console: invite our Google account with app-level permissions: view app information, create/edit draft apps, release to production (including Play App Signing), release to testing tracks, manage store presence, manage policy declarations (Play).',
      'App Store Connect: invite us with the Admin or App Manager role, or create a team API key with Admin access and send the .p8, Key ID and Issuer ID (Apple). The Account Holder must have accepted the latest agreements first.',
      'Apple Developer Program: your team must be active and, if the app has in-app purchases, the Paid Apps agreement accepted by the Account Holder (Apple).',
    ],
  },
  {
    title: 'Listing assets',
    items: [
      'App name, short description or subtitle, full description, keywords (Apple), what’s-new text.',
      'App icon as a 1024 x 1024 PNG, no transparency, no rounded corners.',
      'Screenshots per the checklist we send (phone required; tablet / iPad if the app supports them).',
      'Feature graphic 1024 x 500 (Play).',
      'Support URL, marketing URL (optional), privacy policy URL on a domain you control.',
      'Category, content-rating answers (we send the questionnaire), countries to publish in, price (free or paid).',
    ],
  },
  {
    title: 'Review access',
    items: [
      'A working demo account (username and password) for anything behind a login, plus a test payment method or a way to bypass payment for reviewers.',
      'If the app depends on hardware, a location, a government ID or a specific SIM/MNO, a short screen recording of the full flow.',
      'A contact name, email and phone number for the review team.',
    ],
  },
  {
    title: 'Decisions',
    items: [
      'Release track and rollout: internal / closed / production (Play); manual or automatic release after approval (Apple).',
      'Whether we may answer reviewer questions directly or should forward them to you.',
    ],
  },
];
