import { Controller, Get, Header, Inject, Module } from "@nestjs/common";
import {
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from "@nestjs/swagger";
import { collectDefaultMetrics, Registry } from "prom-client";
import { WageringMetrics } from "./wagering-metrics";

@Controller("metrics")
@ApiTags("Observability")
export class MetricsController {
  constructor(@Inject(Registry) private readonly registry: Registry) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  @ApiOperation({
    summary: "Prometheus metrics",
    description:
      "Exposes runtime and wagering metrics in Prometheus text exposition format.",
  })
  @ApiProduces("text/plain")
  @ApiOkResponse({
    description: "Prometheus text exposition",
    schema: { type: "string" },
  })
  metrics(): Promise<string> {
    return this.registry.metrics();
  }
}

@Module({
  controllers: [MetricsController],
  providers: [
    {
      provide: Registry,
      useFactory: () => {
        const registry = new Registry();
        collectDefaultMetrics({ register: registry });
        return registry;
      },
    },
    WageringMetrics,
  ],
  exports: [Registry, WageringMetrics],
})
export class MetricsModule {}
