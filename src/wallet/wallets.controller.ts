import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Inject,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
  UseFilters,
} from "@nestjs/common";
import {
  CreateWallet,
  isCreateWalletInput,
  isInvalidWalletInputError,
  WalletAlreadyExistsError,
  WalletCreationUnavailableError,
} from "./application/create-wallet";
import { ReadWallet, ReadWalletLedger } from "./application/read-wallet";
import { ReadHttpExceptionFilter } from "../shared/http/read-http-exception.filter";
import type { Wallet } from "./domain/wallet";
import type { WalletLedgerEntry } from "./domain/wallet-ledger-entry";

function walletToResponse(wallet: Wallet) {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

function ledgerEntryToResponse(entry: WalletLedgerEntry) {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    createdAt: entry.createdAt.toISOString(),
  };
}

@Controller("wallets")
export class WalletsController {
  constructor(
    @Inject(CreateWallet) private readonly createWallet: CreateWallet,
    @Inject(ReadWallet) private readonly readWallet: ReadWallet,
    @Inject(ReadWalletLedger)
    private readonly readWalletLedger: ReadWalletLedger,
  ) {}

  @Get(":walletId")
  @UseFilters(ReadHttpExceptionFilter)
  async get(@Param("walletId") walletId: string) {
    return walletToResponse(await this.readWallet.execute(walletId));
  }

  @Get(":walletId/ledger")
  @UseFilters(ReadHttpExceptionFilter)
  async getLedger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    const page = await this.readWalletLedger.execute({
      walletId,
      ...(cursor === undefined ? {} : { cursor }),
      ...(limit === undefined ? {} : { limit }),
    });
    return {
      items: page.items.map(ledgerEntryToResponse),
      nextCursor: page.nextCursor,
    };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown) {
    if (!isCreateWalletInput(body)) {
      throw new BadRequestException("Wallet request payload is invalid");
    }
    try {
      const wallet = await this.createWallet.execute(body);
      return {
        walletId: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        balance: wallet.balance.toJSON().amount,
        version: wallet.version,
      };
    } catch (error) {
      if (error instanceof WalletAlreadyExistsError) {
        throw new ConflictException(error.message);
      }
      if (isInvalidWalletInputError(error)) {
        throw new BadRequestException(
          error instanceof Error ? error.message : "Wallet request is invalid",
        );
      }
      if (error instanceof WalletCreationUnavailableError) {
        throw new ServiceUnavailableException(error.message);
      }
      throw new InternalServerErrorException("Wallet creation failed");
    }
  }
}
