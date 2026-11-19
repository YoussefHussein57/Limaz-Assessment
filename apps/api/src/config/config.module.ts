import { Global, Module } from '@nestjs/common';
import { type Env, loadEnv } from './env.schema';

/** Injection token for the validated, typed environment. */
export const ENV = Symbol('ENV');

/**
 * Makes the validated environment injectable. Combined with the rule that no
 * other file touches `process.env`, this keeps configuration a single typed
 * value flowing through the container rather than ambient global state.
 */
@Global()
@Module({
  providers: [{ provide: ENV, useFactory: (): Env => loadEnv() }],
  exports: [ENV],
})
export class ConfigModule {}
