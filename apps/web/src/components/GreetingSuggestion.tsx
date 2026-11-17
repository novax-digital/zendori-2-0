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
    <p className="field-help">
      Empfehlung{agentMode === 'answer' ? ' (Autopilot)' : ' (Reine Annahme)'}:{' '}
      <button type="button" className="link-button" onClick={() => fill(recommended)}>
        Vorschlag übernehmen
      </button>
      <span className="agents-greeting-text">„{recommended}"</span>
    </p>
  );
}
