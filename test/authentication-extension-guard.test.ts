import { expect, test } from "bun:test";
import { AuthenticationExtensionGuard } from "../src/infrastructure/authentication/authentication-extension.guard";

test("authentication extension guard preserves the challenge's public behavior", () => {
  expect(new AuthenticationExtensionGuard().canActivate({} as never)).toBe(
    true,
  );
});
