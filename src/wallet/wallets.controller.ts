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
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  getSchemaPath,
} from "@nestjs/swagger";
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
import {
  ApiErrorSchema,
  WalletCreateRequestSchema,
  WalletCreateResponseSchema,
  WalletLedgerEntrySchema,
  WalletLedgerPageSchema,
  WalletResponseSchema,
} from "../shared/http/openapi-schemas";

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
@ApiExtraModels(
  ApiErrorSchema,
  WalletCreateRequestSchema,
  WalletCreateResponseSchema,
  WalletLedgerEntrySchema,
  WalletLedgerPageSchema,
  WalletResponseSchema,
)
export class WalletsController {
  constructor(
    @Inject(CreateWallet) private readonly createWallet: CreateWallet,
    @Inject(ReadWallet) private readonly readWallet: ReadWallet,
    @Inject(ReadWalletLedger)
    private readonly readWalletLedger: ReadWalletLedger,
  ) {}

  @Get(":walletId")
  @ApiTags("Wallets")
  @ApiOperation({
    summary: "Get a wallet",
    description:
      "Returns the persisted wallet balance as decimal-string money.",
  })
  @ApiParam({ name: "walletId", type: String })
  @ApiOkResponse({ description: "Wallet found", type: WalletResponseSchema })
  @ApiBadRequestResponse({
    description: "Wallet ID is invalid",
    schema: { $ref: getSchemaPath(ApiErrorSchema) },
  })
  @ApiNotFoundResponse({
    description: "Wallet not found",
    schema: { $ref: getSchemaPath(ApiErrorSchema) },
  })
  @ApiServiceUnavailableResponse({
    description: "A required dependency is temporarily unavailable",
    schema: { $ref: getSchemaPath(ApiErrorSchema) },
  })
  @ApiResponse({
    status: 500,
    description: "Unexpected server error",
    schema: { $ref: getSchemaPath(ApiErrorSchema) },
  })
  @UseFilters(ReadHttpExceptionFilter)
  async get(@Param("walletId") walletId: string) {
    return walletToResponse(await this.readWallet.execute(walletId));
  }

  @Get(":walletId/ledger")
  @ApiTags("Ledger")
  @ApiOperation({
    summary: "List wallet ledger entries",
    description:
      "Uses stable keyset pagination ordered by createdAt DESC, id DESC. The cursor is opaque and scoped to the wallet.",
  })
  @ApiParam({ name: "walletId", type: String })
  @ApiQuery({
    name: "cursor",
    required: false,
    type: String,
    description: "Opaque cursor returned as nextCursor by the previous page.",
  })
  @ApiQuery({
    name: "limit",
    required: false,
    type: Number,
    description: "Page size, default 50, maximum 100.",
    example: 50,
  })
  @ApiOkResponse({ description: "Ledger page", type: WalletLedgerPageSchema })
  @ApiBadRequestResponse({
    description: "Invalid cursor or limit",
    schema: { $ref: getSchemaPath(ApiErrorSchema) },
  })
  @ApiNotFoundResponse({
    description: "Wallet not found",
    schema: { $ref: getSchemaPath(ApiErrorSchema) },
  })
  @ApiServiceUnavailableResponse({
    description: "A required dependency is temporarily unavailable",
    schema: { $ref: getSchemaPath(ApiErrorSchema) },
  })
  @ApiResponse({
    status: 500,
    description: "Unexpected server error",
    schema: { $ref: getSchemaPath(ApiErrorSchema) },
  })
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
  @ApiTags("Wallets")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "Create a wallet",
    description:
      "A positive initial balance creates an internal OPENING transaction, a CREDIT ledger entry and opening events atomically. Zero creates only the wallet.",
  })
  @ApiBody({
    type: WalletCreateRequestSchema,
    examples: {
      positiveOpening: {
        summary: "Create a wallet with an opening balance",
        value: {
          playerId: "player-001",
          currency: "BRL",
          initialBalance: "100.00",
        },
      },
      zeroBalance: {
        summary: "Create an empty wallet",
        value: {
          playerId: "player-002",
          currency: "BRL",
          initialBalance: "0.00",
        },
      },
    },
  })
  @ApiCreatedResponse({
    description: "Wallet created",
    type: WalletCreateResponseSchema,
  })
  @ApiBadRequestResponse({
    description: "Invalid wallet request or monetary string",
    schema: { $ref: getSchemaPath(ApiErrorSchema) },
  })
  @ApiConflictResponse({
    description: "A wallet already exists for this player and currency",
    schema: { $ref: getSchemaPath(ApiErrorSchema) },
  })
  @ApiServiceUnavailableResponse({
    description: "A recognized transient infrastructure failure",
    schema: { $ref: getSchemaPath(ApiErrorSchema) },
  })
  @ApiResponse({
    status: 500,
    description: "Unexpected server error",
    schema: { $ref: getSchemaPath(ApiErrorSchema) },
  })
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
