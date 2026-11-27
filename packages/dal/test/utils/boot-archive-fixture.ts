// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { QueryTypes, type Sequelize } from 'sequelize';

const fixtureSchema = z
  .object({
    schemaVersion: z.literal(1),
    database: z.string().regex(/^boot_archive_fixture_[a-f0-9]{16}$/),
    username: z.string().regex(/^boot_archive_fixture_[a-f0-9]{16}$/),
    password: z.string().min(32),
    marker: z.string().regex(/^boot-archive-fixture:[a-f0-9]{32}$/),
    host: z.string(),
    port: z.literal(5432),
    containerId: z.string().regex(/^[a-f0-9]{64}$/),
    containerName: z.string().regex(/^evyar-.*-restore-[0-9]{8}$/),
    taskLabel: z.string().regex(/^citrineos-upgrade-[0-9]{8}$/),
    networkName: z.string(),
    memoryBytes: z.number().int().positive(),
    expiresAt: z.string(),
  })
  .strict();

const containerSchema = z.object({
  Id: z.string(),
  Name: z.string(),
  Config: z.object({ Labels: z.record(z.string(), z.string()) }),
  State: z.object({ Running: z.boolean(), OOMKilled: z.boolean() }),
  HostConfig: z.object({ Memory: z.number(), MemorySwap: z.number() }),
  NetworkSettings: z.object({
    Networks: z.record(z.string(), z.object({ IPAddress: z.string() })),
  }),
});
const networkSchema = z.object({
  Name: z.string(),
  Internal: z.boolean(),
  Labels: z.record(z.string(), z.string()),
  Containers: z.record(z.string(), z.object({ IPv4Address: z.string() })),
});

export type BootArchiveFixture = z.infer<typeof fixtureSchema>;

export function loadBootArchiveFixture(file: string): BootArchiveFixture {
  assert(
    isAbsolute(file) && realpathSync(file) === file,
    'Explicit canonical fixture path required',
  );
  const stat = lstatSync(file);
  assert(
    stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0,
    'Private fixture file required',
  );
  assert(stat.uid === process.getuid?.(), 'Fixture must belong to the test runner');
  const grant = fixtureSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  assert(grant.database === grant.username, 'Fixture must have its own role');
  assert(
    Number.isFinite(Date.parse(grant.expiresAt)) && Date.parse(grant.expiresAt) > Date.now(),
    'Fixture expired',
  );
  const octets = grant.host.split('.').map(Number);
  assert(
    isIP(grant.host) === 4 &&
      (octets[0] === 10 ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
        (octets[0] === 192 && octets[1] === 168)),
    'Private bridge address required',
  );
  const [container] = z
    .array(containerSchema)
    .length(1)
    .parse(
      JSON.parse(execFileSync('docker', ['inspect', grant.containerId], { encoding: 'utf8' })),
    );
  assert(container.Id === grant.containerId && container.Name === '/' + grant.containerName);
  assert(container.Config.Labels['evyar.task'] === grant.taskLabel);
  assert(container.State.Running && !container.State.OOMKilled);
  assert(
    container.HostConfig.Memory === grant.memoryBytes &&
      container.HostConfig.MemorySwap === grant.memoryBytes,
  );
  assert.deepEqual(Object.keys(container.NetworkSettings.Networks), [grant.networkName]);
  assert(container.NetworkSettings.Networks[grant.networkName].IPAddress === grant.host);
  const [network] = z
    .array(networkSchema)
    .length(1)
    .parse(
      JSON.parse(
        execFileSync('docker', ['network', 'inspect', grant.networkName], { encoding: 'utf8' }),
      ),
    );
  assert(
    network.Name === grant.networkName &&
      network.Internal &&
      network.Labels['evyar.task'] === grant.taskLabel,
  );
  assert.deepEqual(Object.keys(network.Containers), [grant.containerId]);
  assert(network.Containers[grant.containerId].IPv4Address.split('/')[0] === grant.host);
  return grant;
}

export async function verifyBootArchiveDatabase(
  db: Sequelize,
  grant: BootArchiveFixture,
): Promise<void> {
  assert(Date.parse(grant.expiresAt) > Date.now(), 'Fixture expired');
  const [identity] = await db.query<{
    database: string;
    username: string;
    marker: string;
    owner: string;
    superuser: boolean;
    createDb: boolean;
    createRole: boolean;
    replication: boolean;
  }>(
    `SELECT current_database() AS database,current_user AS username,
    shobj_description(d.oid,'pg_database') AS marker,pg_get_userbyid(d.datdba) AS owner,
    r.rolsuper AS superuser,r.rolcreatedb AS "createDb",r.rolcreaterole AS "createRole",r.rolreplication AS replication
    FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`,
    { type: QueryTypes.SELECT },
  );
  assert(
    identity.database === grant.database &&
      identity.username === grant.username &&
      identity.owner === grant.username,
  );
  assert(identity.marker === grant.marker);
  assert(
    !identity.superuser && !identity.createDb && !identity.createRole && !identity.replication,
    'Non-production restricted role required',
  );
}
