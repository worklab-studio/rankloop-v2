import { isErrorCode, type ErrorCode } from "@/shared/error-codes";

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message?: string,
    public readonly details?: Record<string, string>,
  ) {
    super(message ?? code);
    this.name = "AppError";
  }
}

export function asAppError(error: unknown): AppError | null {
  if (error instanceof AppError) return error;
  if (error instanceof Error && isErrorCode(error.message)) {
    return new AppError(error.message, error.message);
  }
  return null;
}

// Codes whose server-side message is safe and useful to show the user.
// Setup errors only: their messages are static guidance ("TEAM_DOMAIN must be
// a full https URL…") that self-hosters need to fix their deployment, and the
// alternative is a generic card that makes every misconfiguration look the
// same. Everything else stays stripped to its bare code.
/**
 * Codes whose server-authored message reaches the user.
 *
 * The default is to send only the code, so an unexpected failure cannot leak
 * internals through its message. These are the codes where the detail IS the
 * value: the generic text for PUBLISH_NOT_CONNECTED cannot know whether the
 * user needs to connect WordPress or a repository, and the generic text for
 * VALIDATION_ERROR cannot name the file that was wrong. Every message behind
 * these codes is written for the user about their own configuration.
 */
const CLIENT_DETAIL_ERROR_CODES = new Set<ErrorCode>([
  "AUTH_CONFIG_MISSING",
  "PUBLISH_NOT_CONNECTED",
  "VALIDATION_ERROR",
  "CONFLICT",
]);

export function toClientError(error: unknown): Error {
  const appError = asAppError(error);
  if (
    appError &&
    CLIENT_DETAIL_ERROR_CODES.has(appError.code) &&
    appError.message !== appError.code
  ) {
    return new Error(`${appError.code}: ${appError.message}`);
  }
  return new Error(appError?.code ?? "INTERNAL_ERROR");
}
