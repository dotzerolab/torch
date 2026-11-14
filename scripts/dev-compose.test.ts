import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Service = {
  image?: string;
  command?: string | string[];
  ports?: string[];
  environment?: Record<string, string>;
  depends_on?: Record<string, { condition?: string }>;
  healthcheck?: { test?: string[] };
};
const compose = parse(
  readFileSync(fileURLToPath(new URL('../docker-compose.dev.yml', import.meta.url)), 'utf8'),
) as { services: Record<string, Service> };

describe('docker-compose.dev.yml', () => {
  it('starts Postgres 17 with logical replication, which both sync engines need', () => {
    const postgres = compose.services.postgres;

    expect(postgres?.image).toMatch(/^postgres:17(\b|$)/);
    expect([postgres?.command].flat().join(' ')).toContain('wal_level=logical');
  });

  it('publishes the dev services on localhost only, with overridable host ports', () => {
    for (const service of Object.values(compose.services)) {
      for (const port of service.ports ?? []) {
        expect(port).toMatch(/^127\.0\.0\.1:\$\{[A-Z0-9_]+:-\d+\}:\d+$/);
      }
    }
  });

  it('starts an S3-compatible store with the API on container port 9000', () => {
    expect(compose.services.s3?.ports?.some((p) => p.endsWith(':9000'))).toBe(true);
  });

  it('starts a Mailpit mail catcher on a pinned tag with SMTP on container port 1025', () => {
    const mail = compose.services.mail;

    expect(mail?.image).toMatch(/^axllent\/mailpit:v\d+\.\d+\.\d+$/);
    expect(mail?.ports?.some((p) => p.endsWith(':1025'))).toBe(true);
    expect(mail?.ports?.some((p) => p.endsWith(':8025'))).toBe(true);
  });

  describe('electric service', () => {
    const electric = compose.services.electric;

    it('pins the exact Electric image (ADR 0001 section 7)', () => {
      expect(electric?.image).toMatch(/^electricsql\/electric:\d+\.\d+\.\d+$/);
    });

    it('reads Postgres with a password and no TLS, and takes its secret from the environment', () => {
      expect(electric?.environment?.DATABASE_URL).toBe(
        'postgresql://torch:torch@postgres:5432/torch?sslmode=disable',
      );
      expect(electric?.environment?.ELECTRIC_SECRET).toMatch(
        /^\$\{ELECTRIC_SECRET:-dev-electric-secret\}$/,
      );
    });

    it('is reachable on localhost only, on an overridable port, and waits for a healthy Postgres', () => {
      expect(electric?.ports).toHaveLength(1);
      expect(electric?.ports?.[0]).toMatch(/^127\.0\.0\.1:\$\{ELECTRIC_PORT:-3010\}:3000$/);
      expect(electric?.depends_on?.postgres?.condition).toBe('service_healthy');
      expect(electric?.healthcheck?.test?.join(' ')).toContain('/v1/health');
    });
  });
});
