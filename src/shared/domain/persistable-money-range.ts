import { Money } from "./money";

const MAX_PERSISTABLE_AMOUNT = "999999999999999999.99";

export function isWithinPersistableMoneyRange(money: Money): boolean {
  const maximum = Money.from({
    amount: MAX_PERSISTABLE_AMOUNT,
    currency: money.currency,
  });
  return !maximum.isLessThan(money);
}
