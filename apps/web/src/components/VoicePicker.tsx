'use client';

import { useRef, useState } from 'react';

// Voice selection with an inline preview: the xAI voices with German labels and
// a play button per selection. Samples are pre-generated WAVs under
// /voice-samples/<voice>.wav (scripts/generate-voice-samples.ts in apps/worker);
// voices without a generated sample get a disabled button with a hint.

export const XAI_VOICES: { id: string; label: string; description: string }[] = [
  { id: 'eve', label: 'Eve', description: 'weiblich, klar und freundlich' },
  { id: 'ara', label: 'Ara', description: 'weiblich, warm und lebendig' },
  { id: 'rex', label: 'Rex', description: 'männlich, ruhig und sachlich' },
  { id: 'sal', label: 'Sal', description: 'männlich, gelassen und tief' },
  { id: 'leo', label: 'Leo', description: 'männlich, energisch und direkt' },
];

export default function VoicePicker({
  id,
  name,
  defaultVoice,
}: {
  id: string;
  name: string;
  defaultVoice: string;
}) {
  const [voice, setVoice] = useState(defaultVoice);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const known = XAI_VOICES.some((v) => v.id === voice);
  // Samples for the five stock voices are committed under public/voice-samples
  // (served from the CDN — an fs check would falsely disable them on Vercel,
  // where static assets are not in the function filesystem). Custom voice ids
  // have no sample; audio.onerror keeps a missing file harmless besides that.
  const hasSample = known;

  function togglePlay(): void {
    if (playing) {
      audioRef.current?.pause();
      setPlaying(false);
      return;
    }
    // Recreate per play: the src depends on the currently selected voice.
    const audio = new Audio(`/voice-samples/${encodeURIComponent(voice)}.wav`);
    audioRef.current?.pause();
    audioRef.current = audio;
    audio.onended = () => setPlaying(false);
    audio.onerror = () => setPlaying(false);
    void audio.play().then(
      () => setPlaying(true),
      () => setPlaying(false)
    );
  }

  return (
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
      <select
        id={id}
        name={name}
        value={voice}
        onChange={(e) => {
          audioRef.current?.pause();
          setPlaying(false);
          setVoice(e.target.value);
        }}
        style={{ flex: 1 }}
      >
        {XAI_VOICES.map((v) => (
          <option key={v.id} value={v.id}>
            {v.label} — {v.description}
          </option>
        ))}
        {!known ? <option value={voice}>{voice} (eigene Stimme)</option> : null}
      </select>
      <button
        type="button"
        className="ghost"
        onClick={togglePlay}
        disabled={!hasSample}
        title={hasSample ? 'Hörprobe abspielen' : 'Für diese Stimme ist noch keine Hörprobe hinterlegt.'}
        aria-label={playing ? 'Hörprobe stoppen' : 'Hörprobe abspielen'}
        style={{ whiteSpace: 'nowrap' }}
      >
        {playing ? '◼ Stopp' : '▶ Anhören'}
      </button>
    </div>
  );
}
