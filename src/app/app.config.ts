import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { HttpBackend, provideHttpClient, withInterceptorsFromDi } from '@angular/common/http';
import { OfflineHttpBackend } from '@bizuri/offline-http';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideHttpClient(withInterceptorsFromDi()),
    // Sits below the interceptor chain, so interceptors and feature code are
    // unchanged. Anything not offline-capable falls through to the network.
    { provide: HttpBackend, useClass: OfflineHttpBackend },
  ],
};
