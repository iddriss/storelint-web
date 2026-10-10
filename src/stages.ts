/**
 * Delivery stages of a paid order. Separate from the payment status (`orders.status`):
 * the status says whether money arrived, the stage says where the work is.
 */
export const PIPELINE = ['paid', 'intake_received', 'in_progress', 'submitted', 'in_review', 'live'] as const;
export type PipelineStage = (typeof PIPELINE)[number];
export type OrderStage = PipelineStage | 'needs_client' | 'cancelled';
export const ORDER_STAGES: readonly OrderStage[] = [...PIPELINE, 'needs_client', 'cancelled'];

export function isOrderStage(v: unknown): v is OrderStage {
  return typeof v === 'string' && (ORDER_STAGES as readonly string[]).includes(v);
}

export function isPipelineStage(v: unknown): v is PipelineStage {
  return typeof v === 'string' && (PIPELINE as readonly string[]).includes(v);
}

/** Short label for steppers, tables and selects. */
export const STAGE_LABELS: Record<OrderStage, string> = {
  paid: 'Paid',
  intake_received: 'Intake received',
  in_progress: 'In progress',
  submitted: 'Submitted',
  in_review: 'In review',
  live: 'Live',
  needs_client: 'Waiting on you',
  cancelled: 'Cancelled',
};

/** What the team sees for the same stages (only `needs_client` reads differently). */
export const ADMIN_STAGE_LABELS: Record<OrderStage, string> = { ...STAGE_LABELS, needs_client: 'Needs client' };

/** One-line headline shown to the client for the current stage. */
export const STAGE_HEADLINES: Record<OrderStage, string> = {
  paid: 'Payment received. We need the intake to start.',
  intake_received: 'Intake received. We are checking it.',
  in_progress: 'We are working on your release.',
  submitted: 'Submitted to the store.',
  in_review: 'In store review.',
  live: 'Your app is live.',
  needs_client: 'We are waiting on you.',
  cancelled: 'This order is cancelled.',
};

/**
 * "What happens next" copy per stage, taken from services/release-ops/OFFER.md
 * (turnaround, review times, rejection handling). `team` is the address clients invite.
 */
export function nextSteps(stage: OrderStage, o: { plan: string; team: string }): string[] {
  const fix = o.plan === 'fix';
  switch (stage) {
    case 'paid':
      return [
        'Fill in the intake form below. It takes about five minutes.',
        `Invite ${o.team} to the repository and to your store console${o.plan === 'both' ? 's' : ''}. We never need your own password.`,
        fix
          ? 'Forward the rejection message from the store. Diagnosis comes within 24 hours of receiving it.'
          : 'The 48-hour clock starts when we have everything on the intake checklist. If something is missing we tell you within 12 hours.',
      ];
    case 'intake_received':
      return [
        'We check the intake and confirm we can reach the repository and the store consoles.',
        'If anything is missing you hear from us within 12 hours, here and by email.',
        fix ? 'Once the intake is complete you get the diagnosis within 24 hours.' : 'Once the intake is complete the 48-hour clock starts.',
      ];
    case 'in_progress':
      return [
        fix
          ? 'We are diagnosing the rejection and fixing its cause. Re-submission follows within 48 hours when the fix is in scope.'
          : 'We are fixing every StoreLint blocker, setting up release signing, and preparing the listing and the privacy forms.',
        'Every change lands in a branch or pull request with a plain-English description. Nothing is force-pushed to your main branch.',
        fix ? 'If the fix needs new features built, we tell you before doing anything else.' : 'The build is submitted for review within 48 hours of a complete intake.',
      ];
    case 'submitted':
      return [
        'The build is uploaded and submitted for review.',
        'Apple usually responds within one to three days. Google Play takes anything from a few hours to seven days or more for a new app.',
        'We watch the review status. You do not need to do anything unless we ask.',
      ];
    case 'in_review':
      return [
        'The store is reviewing the app. We answer reviewer questions, and anything that commits you to something gets your sign-off first.',
        'If the store rejects the build we diagnose and fix it. One full re-submission is included.',
        'If a rejection is caused by something we did or missed, we keep going until the app is live at no extra charge.',
      ];
    case 'live':
      return [
        'The app is approved and published.',
        'You get a written handover: what changed, why, where the signing keys live and how to release next time.',
        'Rejected within 30 days of our submission? We fix it free.',
      ];
    case 'needs_client':
      return [
        'Work is paused until the item above is sorted, and so is the 48-hour clock.',
        'Update the intake form or send us a message below once it is done.',
      ];
    case 'cancelled':
      return ['No further work happens on this order. If this is unexpected, send us a message below.'];
  }
}
