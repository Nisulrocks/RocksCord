/**
 * Notification sounds.
 *
 * Synthesised with Web Audio rather than shipping audio files. Two short sine tones are a
 * few lines of code and no bytes at all, where an mp3 would be an asset to host, a CSP
 * `media-src` to widen, and a request on every first play. It also means the sound is
 * described in the code rather than in a binary nobody can inspect.
 *
 * The tones are deliberately soft and short. A notification sound is heard hundreds of
 * times a day by someone who did not choose to hear it, so the bar is "noticeable once"
 * rather than "attention-grabbing every time".
 */

import { useSettingsStore } from '../store/useSettingsStore';

export type SoundName =
  | 'mention'
  | 'message'
  | 'join'
  | 'leave'
  | 'connect'
  | 'disconnect'
  | 'mute'
  | 'unmute'
  | 'deafen'
  | 'undeafen';

/**
 * One context, created on first use.
 *
 * Browsers refuse to start an AudioContext before a user gesture, so constructing it at
 * module load would produce a suspended context and a console warning on every page load.
 */
let context: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    context ??= new AudioContext();
    // A context suspended by autoplay policy resumes once the page has been interacted
    // with, which by the time a notification arrives it always has been.
    if (context.state === 'suspended') void context.resume().catch(() => {});
    return context;
  } catch {
    // No Web Audio at all. Silence is an acceptable degradation.
    return null;
  }
}

interface Tone {
  /** Hertz. */
  frequency: number;
  /** Seconds from the start of the sound. */
  at: number;
  duration: number;
}

/**
 * Each sound is a small melody.
 *
 * Rising intervals read as arrival, falling as departure — which is why join and leave
 * are the same two notes in opposite orders, and why nobody has to be told which is which.
 */
const SOUNDS: Record<SoundName, { tones: Tone[]; gain: number }> = {
  // Two rising notes, a perfect fourth apart: distinct enough to cut through, not shrill.
  mention: { gain: 0.16, tones: [
    { frequency: 660, at: 0, duration: 0.09 },
    { frequency: 880, at: 0.08, duration: 0.13 },
  ] },
  // Quieter and flatter than a mention, because it is not addressed to you.
  message: { gain: 0.08, tones: [{ frequency: 620, at: 0, duration: 0.07 }] },
  join: { gain: 0.1, tones: [
    { frequency: 520, at: 0, duration: 0.07 },
    { frequency: 780, at: 0.06, duration: 0.1 },
  ] },
  leave: { gain: 0.1, tones: [
    { frequency: 780, at: 0, duration: 0.07 },
    { frequency: 520, at: 0.06, duration: 0.1 },
  ] },

  /*
   * You joining or leaving a call, as opposed to someone else arriving in one.
   *
   * Three notes rather than two, and spanning an octave rather than a fourth: connecting
   * is a bigger event than a person walking in, and it should not be mistakable for one
   * while you are already sitting in a busy channel. Both open on a pitch no other sound
   * here uses, so the first note alone is enough to tell them apart.
   */
  connect: { gain: 0.13, tones: [
    { frequency: 440, at: 0, duration: 0.06 },
    { frequency: 587, at: 0.055, duration: 0.06 },
    { frequency: 880, at: 0.11, duration: 0.13 },
  ] },
  disconnect: { gain: 0.13, tones: [
    { frequency: 880, at: 0, duration: 0.06 },
    { frequency: 587, at: 0.055, duration: 0.06 },
    { frequency: 440, at: 0.11, duration: 0.14 },
  ] },

  /*
   * Mute and deafen confirm something you just did, so they answer a different question
   * from the sounds above: not "look at this" but "yes, that worked". They are shorter and
   * drier than join and leave for that reason -- and pitched below them, so a room full of
   * people arriving never sounds like your own microphone cutting out.
   *
   * Off falls, on rises. The pair is the same two notes reversed, which is what makes them
   * legible without ever being explained.
   */
  mute: { gain: 0.11, tones: [
    { frequency: 520, at: 0, duration: 0.05 },
    { frequency: 390, at: 0.045, duration: 0.08 },
  ] },
  unmute: { gain: 0.11, tones: [
    { frequency: 390, at: 0, duration: 0.05 },
    { frequency: 520, at: 0.045, duration: 0.08 },
  ] },

  /*
   * Deafen is the same gesture lower down, and a little longer. It is the heavier action
   * -- it silences everyone, not just you -- and going lower rather than louder says so
   * without the sound itself becoming the loudest thing in the app.
   *
   * All four open on a different note, which is the part that has to be got right rather
   * than assumed: direction alone is not enough to tell them apart, because you hear the
   * first note before there is any direction to hear. An earlier pass had unmute starting
   * at 390 and deafen at 400, near enough to be the same sound until it was too late.
   *
   * Kept above ~200Hz deliberately. Laptop speakers roll off below that, and a
   * confirmation tone that is inaudible on the most common hardware is not one.
   */
  deafen: { gain: 0.12, tones: [
    { frequency: 330, at: 0, duration: 0.06 },
    { frequency: 220, at: 0.055, duration: 0.11 },
  ] },
  undeafen: { gain: 0.12, tones: [
    { frequency: 220, at: 0, duration: 0.06 },
    { frequency: 330, at: 0.055, duration: 0.11 },
  ] },
};

export function playSound(name: SoundName): void {
  if (!useSettingsStore.getState().notificationSounds) return;

  const ctx = audio();
  if (!ctx) return;

  const { tones, gain } = SOUNDS[name];
  const start = ctx.currentTime;

  for (const tone of tones) {
    const oscillator = ctx.createOscillator();
    const envelope = ctx.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.value = tone.frequency;

    /*
     * A short attack and an exponential decay. A bare gain of 1 would click audibly at
     * both ends, because a waveform cut mid-cycle is a step change — which is exactly
     * what a click is.
     */
    const from = start + tone.at;
    envelope.gain.setValueAtTime(0.0001, from);
    envelope.gain.exponentialRampToValueAtTime(gain, from + 0.012);
    envelope.gain.exponentialRampToValueAtTime(0.0001, from + tone.duration);

    oscillator.connect(envelope).connect(ctx.destination);
    oscillator.start(from);
    oscillator.stop(from + tone.duration + 0.02);
  }
}
