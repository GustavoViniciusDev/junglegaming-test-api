import type { MikroORM } from "@mikro-orm/postgresql";
import Decimal from "decimal.js";

type WalletRow = {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
};

type TransactionRow = {
  id: string;
  wallet_id: string;
  player_id: string;
  provider_id: string | null;
  external_transaction_id: string | null;
  round_id: string | null;
  kind: string;
  status: string;
  amount: string;
  currency: string;
  reference_transaction_id: string | null;
  resulting_balance: string | null;
};

type LedgerRow = {
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  created_at: Date | string;
};

export interface GlobalFinancialAuditResult {
  walletsChecked: number;
  transactionsChecked: number;
  ledgerEntriesChecked: number;
  checks: {
    walletLedgerReconstruction: "PASS";
    transactionToLedger: "PASS";
    ledgerToTransaction: "PASS";
    lossNoLedger: "PASS";
    rejectedNoLedger: "PASS";
    pendingReferenceNoLedger: "PASS";
    opening: "PASS";
    reversals: "PASS";
    duplicateLedger: "PASS";
    nonnegativeBalances: "PASS";
  };
}

function requireCondition(
  condition: boolean,
  message: string,
): asserts condition {
  if (!condition) throw new Error(`Global financial audit failed: ${message}`);
}

function decimal(value: string, label: string): Decimal {
  try {
    return new Decimal(value);
  } catch {
    throw new Error(
      `Global financial audit failed: invalid decimal in ${label}`,
    );
  }
}

function expectedLedgerDirection(
  transaction: TransactionRow,
  reference: TransactionRow | undefined,
): string | null {
  switch (transaction.kind) {
    case "OPENING":
    case "WIN":
    case "REFUND":
      return "CREDIT";
    case "BET":
      return "DEBIT";
    case "ROLLBACK":
      requireCondition(
        reference !== undefined,
        `rollback ${transaction.id} has no reference`,
      );
      if (reference.kind === "BET") return "CREDIT";
      if (reference.kind === "WIN" || reference.kind === "REFUND")
        return "DEBIT";
      throw new Error(
        `Global financial audit failed: invalid rollback reference kind for ${transaction.id}`,
      );
    default:
      return null;
  }
}

export async function assertGlobalFinancialConsistency(
  orm: MikroORM,
): Promise<GlobalFinancialAuditResult> {
  const connection = orm.em.getConnection();
  const wallets = (await connection.execute(
    "select id, player_id, currency, balance from wallets order by id",
  )) as WalletRow[];
  const transactions = (await connection.execute(
    `select id, wallet_id, player_id, provider_id, external_transaction_id,
            round_id, kind, status, amount, currency, reference_transaction_id,
            resulting_balance
     from wager_transactions order by id`,
  )) as TransactionRow[];
  const ledger = (await connection.execute(
    `select id, wallet_id, transaction_id, direction, amount, currency,
            balance_before, balance_after, created_at
     from wallet_ledger_entries order by wallet_id, created_at, id`,
  )) as LedgerRow[];

  const walletById = new Map(wallets.map((wallet) => [wallet.id, wallet]));
  const transactionById = new Map(
    transactions.map((transaction) => [transaction.id, transaction]),
  );
  const ledgerByTransaction = new Map<string, LedgerRow[]>();
  const ledgerByWallet = new Map<string, LedgerRow[]>();
  const ledgerUniqueKeys = new Set<string>();

  for (const entry of ledger) {
    const wallet = walletById.get(entry.wallet_id);
    const transaction = transactionById.get(entry.transaction_id);
    requireCondition(
      wallet !== undefined,
      `ledger ${entry.id} is orphaned from Wallet`,
    );
    requireCondition(
      transaction !== undefined,
      `ledger ${entry.id} is orphaned from WagerTransaction`,
    );
    requireCondition(
      transaction.wallet_id === entry.wallet_id,
      `ledger ${entry.id} belongs to another transaction Wallet`,
    );
    requireCondition(
      entry.currency === wallet.currency &&
        entry.currency === transaction.currency,
      `ledger ${entry.id} currency mismatch`,
    );

    const uniqueKey = `${entry.transaction_id}\u0000${entry.wallet_id}`;
    requireCondition(
      !ledgerUniqueKeys.has(uniqueKey),
      `duplicate ledger for transaction ${entry.transaction_id} and Wallet ${entry.wallet_id}`,
    );
    ledgerUniqueKeys.add(uniqueKey);

    const amount = decimal(entry.amount, `ledger ${entry.id} amount`);
    const before = decimal(
      entry.balance_before,
      `ledger ${entry.id} balance_before`,
    );
    const after = decimal(
      entry.balance_after,
      `ledger ${entry.id} balance_after`,
    );
    requireCondition(
      amount.isPositive(),
      `ledger ${entry.id} amount is not positive`,
    );
    requireCondition(
      !before.isNegative() && !after.isNegative(),
      `ledger ${entry.id} contains a negative balance`,
    );
    const calculated =
      entry.direction === "CREDIT"
        ? before.plus(amount)
        : entry.direction === "DEBIT"
          ? before.minus(amount)
          : null;
    requireCondition(
      calculated !== null,
      `ledger ${entry.id} has an unsupported direction`,
    );
    requireCondition(
      calculated.equals(after),
      `ledger ${entry.id} arithmetic is inconsistent`,
    );

    const transactionEntries =
      ledgerByTransaction.get(entry.transaction_id) ?? [];
    transactionEntries.push(entry);
    ledgerByTransaction.set(entry.transaction_id, transactionEntries);
    const walletEntries = ledgerByWallet.get(entry.wallet_id) ?? [];
    walletEntries.push(entry);
    ledgerByWallet.set(entry.wallet_id, walletEntries);
  }

  for (const wallet of wallets) {
    const stored = decimal(wallet.balance, `Wallet ${wallet.id} balance`);
    requireCondition(
      !stored.isNegative(),
      `Wallet ${wallet.id} has a negative balance`,
    );
    let reconstructed = new Decimal("0.00");
    for (const entry of ledgerByWallet.get(wallet.id) ?? []) {
      const before = decimal(
        entry.balance_before,
        `ledger ${entry.id} balance_before`,
      );
      const after = decimal(
        entry.balance_after,
        `ledger ${entry.id} balance_after`,
      );
      requireCondition(
        before.equals(reconstructed),
        `ledger chain breaks at ${entry.id} for Wallet ${wallet.id}`,
      );
      reconstructed =
        entry.direction === "CREDIT"
          ? reconstructed.plus(entry.amount)
          : reconstructed.minus(entry.amount);
      requireCondition(
        !reconstructed.isNegative(),
        `ledger reconstruction becomes negative for Wallet ${wallet.id}`,
      );
      requireCondition(
        reconstructed.equals(after),
        `ledger chain arithmetic differs at ${entry.id}`,
      );
    }
    requireCondition(
      reconstructed.equals(stored),
      `Wallet ${wallet.id} balance differs from Ledger reconstruction`,
    );
  }

  for (const transaction of transactions) {
    const entries = ledgerByTransaction.get(transaction.id) ?? [];
    const amount = decimal(
      transaction.amount,
      `transaction ${transaction.id} amount`,
    );
    const reference =
      transaction.reference_transaction_id === null
        ? undefined
        : transactionById.get(transaction.reference_transaction_id);
    if (transaction.reference_transaction_id !== null) {
      requireCondition(
        reference !== undefined,
        `transaction ${transaction.id} references a missing transaction`,
      );
      requireCondition(
        reference.wallet_id === transaction.wallet_id,
        `transaction ${transaction.id} reference Wallet mismatch`,
      );
      requireCondition(
        reference.player_id === transaction.player_id,
        `transaction ${transaction.id} reference player mismatch`,
      );
      requireCondition(
        reference.currency === transaction.currency,
        `transaction ${transaction.id} reference currency mismatch`,
      );
      requireCondition(
        reference.provider_id === transaction.provider_id,
        `transaction ${transaction.id} reference provider mismatch`,
      );
      requireCondition(
        reference.round_id === transaction.round_id,
        `transaction ${transaction.id} reference round mismatch`,
      );
    }

    if (transaction.kind === "OPENING") {
      if (amount.isPositive()) {
        requireCondition(
          transaction.status === "PROCESSED",
          `positive OPENING ${transaction.id} is not PROCESSED`,
        );
        requireCondition(
          entries.length === 1,
          `positive OPENING ${transaction.id} must have exactly one Ledger entry`,
        );
        requireCondition(
          entries[0]?.direction === "CREDIT",
          `OPENING ${transaction.id} Ledger is not CREDIT`,
        );
        requireCondition(
          decimal(
            entries[0]?.amount ?? "0",
            `OPENING ${transaction.id} Ledger amount`,
          ).equals(amount),
          `OPENING ${transaction.id} amount differs from Ledger`,
        );
        requireCondition(
          transaction.resulting_balance !== null &&
            decimal(
              transaction.resulting_balance,
              `OPENING ${transaction.id} resulting balance`,
            ).equals(entries[0]?.balance_after),
          `OPENING ${transaction.id} resulting balance differs from Ledger`,
        );
      } else {
        requireCondition(
          entries.length === 0,
          `zero-value OPENING ${transaction.id} created a financial Ledger entry`,
        );
      }
      continue;
    }

    if (transaction.status === "REJECTED") {
      requireCondition(
        entries.length === 0,
        `REJECTED transaction ${transaction.id} has Ledger entries`,
      );
      continue;
    }
    if (transaction.status === "PENDING_REFERENCE") {
      requireCondition(
        entries.length === 0,
        `PENDING_REFERENCE transaction ${transaction.id} has Ledger entries`,
      );
      requireCondition(
        ["WIN", "REFUND", "ROLLBACK"].includes(transaction.kind),
        `ineligible ${transaction.kind} transaction ${transaction.id} is PENDING_REFERENCE`,
      );
      continue;
    }
    if (transaction.status !== "PROCESSED") {
      requireCondition(
        entries.length === 0,
        `non-processed transaction ${transaction.id} has Ledger entries`,
      );
      continue;
    }

    const expectedDirection = expectedLedgerDirection(transaction, reference);
    if (expectedDirection === null) {
      requireCondition(
        transaction.kind === "LOSS" && entries.length === 0,
        `non-balance-changing transaction ${transaction.id} has an unexpected Ledger entry`,
      );
      continue;
    }
    requireCondition(
      entries.length === 1,
      `processed balance-changing transaction ${transaction.id} must have exactly one Ledger entry`,
    );
    const entry = entries[0];
    requireCondition(
      entry?.direction === expectedDirection,
      `transaction ${transaction.id} has incorrect Ledger direction`,
    );
    requireCondition(
      decimal(
        entry?.amount ?? "0",
        `transaction ${transaction.id} Ledger amount`,
      ).equals(amount),
      `transaction ${transaction.id} amount differs from Ledger`,
    );
    requireCondition(
      transaction.wallet_id === entry?.wallet_id &&
        transaction.currency === entry?.currency,
      `transaction ${transaction.id} Ledger identity mismatch`,
    );
    requireCondition(
      transaction.resulting_balance !== null &&
        decimal(
          transaction.resulting_balance,
          `transaction ${transaction.id} resulting balance`,
        ).equals(entry?.balance_after),
      `transaction ${transaction.id} resulting balance differs from Ledger`,
    );

    if (transaction.kind === "REFUND") {
      requireCondition(
        reference !== undefined &&
          reference.kind === "BET" &&
          reference.status === "PROCESSED",
        `processed REFUND ${transaction.id} has an invalid reference`,
      );
      requireCondition(
        amount.equals(reference.amount),
        `processed REFUND ${transaction.id} amount differs from its BET`,
      );
    }
    if (
      transaction.kind === "WIN" &&
      transaction.reference_transaction_id !== null
    ) {
      requireCondition(
        reference !== undefined &&
          reference.kind === "BET" &&
          reference.status === "PROCESSED",
        `processed referenced WIN ${transaction.id} has an invalid BET reference`,
      );
    }
    if (transaction.kind === "ROLLBACK") {
      requireCondition(
        reference !== undefined &&
          reference.status === "PROCESSED" &&
          ["BET", "WIN", "REFUND"].includes(reference.kind),
        `processed ROLLBACK ${transaction.id} has an invalid reference`,
      );
      requireCondition(
        amount.equals(reference.amount),
        `processed ROLLBACK ${transaction.id} amount differs from its reference`,
      );
    }
  }

  return {
    walletsChecked: wallets.length,
    transactionsChecked: transactions.length,
    ledgerEntriesChecked: ledger.length,
    checks: {
      walletLedgerReconstruction: "PASS",
      transactionToLedger: "PASS",
      ledgerToTransaction: "PASS",
      lossNoLedger: "PASS",
      rejectedNoLedger: "PASS",
      pendingReferenceNoLedger: "PASS",
      opening: "PASS",
      reversals: "PASS",
      duplicateLedger: "PASS",
      nonnegativeBalances: "PASS",
    },
  };
}
