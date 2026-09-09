// Connection-pinned voice-session bindings for shipped Talk clients that consult
// without creating a voice session. The map is module-private so every read and
// write prunes expired rows together; exposing it would let a caller resurrect a
// binding past its TTL or leak entries for closed connections.

const LEGACY_VOICE_BINDING_TTL_MS = 6 * 60 * 60_000;

const legacyVoiceSessionByClient = new Map<string, { voiceSessionId: string; expiresAt: number }>();

function legacyVoiceBindingKey(connId: string, agentId: string, sessionKey: string): string {
  // Unqualified voice keys can identify different agents on the same connection.
  return `${connId}\0${agentId}\0${sessionKey}`;
}

function pruneLegacyVoiceBindings(now: number): void {
  for (const [key, binding] of legacyVoiceSessionByClient) {
    if (binding.expiresAt <= now) {
      legacyVoiceSessionByClient.delete(key);
    }
  }
}

/** Pins a resolved voice session to one connection so later consults reuse it. */
export function rememberLegacyVoiceBinding(params: {
  connId: string;
  agentId: string;
  sessionKey: string;
  voiceSessionId: string;
}): void {
  const now = Date.now();
  pruneLegacyVoiceBindings(now);
  legacyVoiceSessionByClient.set(
    legacyVoiceBindingKey(params.connId, params.agentId, params.sessionKey),
    {
      voiceSessionId: params.voiceSessionId,
      expiresAt: now + LEGACY_VOICE_BINDING_TTL_MS,
    },
  );
}

/** Returns the pinned voice session id, dropping it first when the TTL has passed. */
export function readLegacyVoiceBinding(
  connId: string,
  agentId: string,
  sessionKey: string,
): string | undefined {
  pruneLegacyVoiceBindings(Date.now());
  return legacyVoiceSessionByClient.get(legacyVoiceBindingKey(connId, agentId, sessionKey))
    ?.voiceSessionId;
}

/** Releases the binding only when it still points at the closing voice session. */
export function forgetLegacyVoiceBinding(
  connId: string,
  agentId: string,
  sessionKey: string,
  voiceSessionId: string | undefined,
): void {
  const key = legacyVoiceBindingKey(connId, agentId, sessionKey);
  if (legacyVoiceSessionByClient.get(key)?.voiceSessionId === voiceSessionId) {
    legacyVoiceSessionByClient.delete(key);
  }
}
