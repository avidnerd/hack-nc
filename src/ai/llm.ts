/**
 * The v1 door to a language model: `complete(system, user) -> string | null`.
 *
 * v1 called Gemini or Claude here to rescue a voice command the regex grammar
 * missed and to reword narration. v2 runs on NVIDIA open models only: commands
 * go to the agent backend (Nemotron on Nebius, agentClient.ts), so this door is
 * closed and every caller keeps its template or grammar path.
 */

// DECISION: closed-model providers removed for v2 (CLAUDE.md section 0: "Patient
// CT never touches a closed model"); the interface stays so callers need no change.

export function llmEnabled(): boolean {
  return false;
}

export function llmName(): string {
  return 'off (agent backend handles language)';
}

export async function complete(_system: string, _user: string, _timeoutMs?: number): Promise<string | null> {
  return null;
}
