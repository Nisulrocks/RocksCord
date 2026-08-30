/**
 * The note from the developer, shown once.
 *
 * Deliberately not a feature tour. Nobody reads those, and the point of this one is not to
 * explain the app -- it is to say who made it and why, before someone forms an opinion
 * about a first load that took a moment because the free tier was asleep. Knowing that up
 * front turns a rough edge into context.
 *
 * Whether it has been seen is remembered per account, so signing in as somebody else shows
 * it to them rather than treating the machine as one person.
 */

import { Modal } from '../ui/Modal';
import { Button } from '../ui/primitives';

const STORAGE_PREFIX = 'rockscord.welcomed.';

/** True when this account has not been shown the note on this device. */
export function shouldWelcome(userId: string): boolean {
  try {
    return localStorage.getItem(`${STORAGE_PREFIX}${userId}`) === null;
  } catch {
    // Private browsing, or storage disabled. Not showing it is the kinder failure: an
    // unskippable greeting on every single load is worse than never seeing it.
    return false;
  }
}

export function markWelcomed(userId: string): void {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${userId}`, String(Date.now()));
  } catch {
    // Nothing to do. The check above fails closed, so this cannot cause a repeat.
  }
}

export function WelcomeModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal open onClose={onClose} width="md" hideClose>
      <div className="flex flex-col items-center gap-4 px-1 pb-1 text-center">
        <img src="/icon-192.png" alt="" width={64} height={64} className="h-16 w-16" />

        <div>
          <h2 className="text-[21px] font-semibold tracking-tight text-ink">
            Welcome to RocksCord
          </h2>
          <p className="mt-1 text-[13px] text-ink-faint">A note from the developer</p>
        </div>

        <div className="space-y-3 text-left text-[14px] leading-relaxed text-ink-dim">
          <p>
            Hey, it&rsquo;s me &mdash; <span className="font-semibold text-ink">Nisulrocks</span>,
            the developer of this very application you&rsquo;re using.
          </p>
          <p>
            Yes, this is a clone of Discord with limited features, as the budget was literally
            0 dollars. Everything you&rsquo;re looking at runs on free tiers, so the server
            falls asleep when nobody&rsquo;s around and the first load after a quiet spell
            takes a moment. That isn&rsquo;t broken. That&rsquo;s just free.
          </p>
          <p>
            But it is real. Messages, voice, video, screen sharing, servers, roles,
            invites &mdash; all of it actually works, and all of it was built from nothing.
          </p>
          <p>
            The reason I&rsquo;m writing this is simple: thank you. You didn&rsquo;t have to be
            here. You could be using the real thing right now, and instead you&rsquo;re trying
            something I made in my spare time. That genuinely means a lot to me.
          </p>
          <p>
            If something breaks, tell me &mdash; you&rsquo;ll probably be the first person to
            find it. And if something in here makes you smile, tell me that too. That&rsquo;s
            the only payment this project has ever taken.
          </p>
          <p className="text-ink">Have fun in here.</p>
        </div>

        <Button block size="lg" onClick={onClose} className="mt-1">
          Thanks, let me in
        </Button>
      </div>
    </Modal>
  );
}
