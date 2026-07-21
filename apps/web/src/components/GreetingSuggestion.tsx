'use client';

// Fills the voice greeting input with a recommended text. The recommendation
// depends on the assigned agent's behavior: intake mode should tell the caller
// their request is being TAKEN and forwarded, autopilot may invite questions.

export default function GreetingSuggestion({
  inputId,
  companyName,
  agentMode,
}: {
  inputId: string;
  companyName: string;
  /** Resolved mode of the channel's assigned agent (null = none assigned → intake fallback). */
  agentMode: 'answer' | 'intake' | null;
}) {
  const intakeText = `Guten Tag, hier ist der digitale Assistent von ${companyName}. Ich nehme Ihr Anliegen gerne auf und leite es an unser Team weiter. Was kann ich für Sie notieren?`;
  const answerText = `Guten Tag, hier ist der digitale Assistent von ${companyName}. Wie kann ich Ihnen helfen?`;
  const recommended = agentMode === 'answer' ? answerText : intakeText;

  function fill(text: string): void {
    const input = document.getElementById(inputId) as HTMLInputElement | null;
    if (input) {
      input.value = text;
      // Notify potential listeners (React uncontrolled inputs just take it).
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    }
  }

  return (
    <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.35rem' }}>
      Empfehlung{agentMode === 'answer' ? ' (Autopilot)' : ' (Reine Annahme)'}:{' '}
      <button
        type="button"
        onClick={() => fill(recommended)}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          color: 'var(--brand-600)',
          cursor: 'pointer',
          font: 'inherit',
          textDecoration: 'underline',
        }}
      >
        Vorschlag übernehmen
      </button>
      <span style={{ display: 'block', marginTop: '0.2rem' }}>„{recommended}"</span>
    </p>
  );
}
