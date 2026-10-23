import { Controller, Get, Header, Inject, Module } from "@nestjs/common";
import { collectDefaultMetrics, Registry } from "prom-client";
import { WageringMetrics } from "./wagering-metrics";

@Controller("metrics")
export class MetricsController {
  constructor(@Inject(Registry) private readonly registry: Registry) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
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
