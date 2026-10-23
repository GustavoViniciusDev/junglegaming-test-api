import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";

/**
 * Explicit HTTP authentication extension point for this challenge.
 * Replace this allow-all guard with an OIDC-backed guard before public exposure.
 */
@Injectable()
export class AuthenticationExtensionGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}
