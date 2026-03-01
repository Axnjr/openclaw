/**
 * Shared constants for the secure env-vars encryption protocol.
 *
 * IMPORTANT: The value of ENV_VARS_HKDF_INFO MUST stay in sync with the
 * mobile client constant in:
 *   claw/mobile/src/constants/env-vars-constants.ts
 */

/** HKDF-SHA256 info string used to derive the AES-256-GCM key from the gateway token. */
export const ENV_VARS_HKDF_INFO = "lazzy-env-vars-v1";
