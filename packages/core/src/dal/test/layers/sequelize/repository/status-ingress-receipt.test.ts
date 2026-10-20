import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageOrigin, MessageState, OCPPVersion } from '@citrineos/base';
import { SequelizeOCPPMessageRepository } from '../../../../layers/sequelize/repository/OCPPMessage.js';
import { OCPPMessage } from '../../../../layers/sequelize/model/OCPPMessage.js';

describe('original status CALL receipt', () => {
  afterEach(() => vi.restoreAllMocks());

  function fixture() {
    const rows: any[] = [];
    const transaction = {};
    let active = 'socket-a';
    const query = vi.fn(async (_sql: string, options: any) => [
      options.replacements.connection === active ? [{ id: 1 }] : [], {},
    ]);
    vi.spyOn(OCPPMessage, 'findOne').mockImplementation(async (options: any) => rows.find((row) =>
      Object.entries(options.where).every(([key, value]) => row[key] === value)) ?? null);
    const create = vi.spyOn(OCPPMessage, 'create').mockImplementation(async (values: any, options: any) => {
      expect(options.transaction).toBe(transaction);
      const row = { ...values, id: rows.length + 1 };
      rows.push(row);
      return row;
    });
    const repository = Object.create(SequelizeOCPPMessageRepository.prototype) as SequelizeOCPPMessageRepository;
    Object.defineProperty(repository, 's', { value: { query, transaction: async (work: any) => work(transaction) } });
    const message = () => ({ tenantId: 1, ocppConnectionName: 'station', correlationId: 'call-1',
      statusIngressConnection: active, origin: MessageOrigin.ChargingStation, state: MessageState.Request,
      protocol: OCPPVersion.OCPP1_6, action: 'StatusNotification', timestamp: '2026-10-20T19:59:59.119Z',
      message: [2, 'call-1', 'StatusNotification', { connectorId: 1, status: 'Available', timestamp: '2026-10-20T19:59:59.116Z' }],
    });
    return { repository, message, rows, create, query, activate: (value: string) => { active = value; } };
  }

  it('reuses the actual original id on exact replay and refuses divergent same-socket identity', async () => {
    const f = fixture();
    const first = await f.repository.reserveStatusIngress(1, f.message());
    expect((await f.repository.reserveStatusIngress(1, f.message())).id).toBe(first.id);
    const changed = f.message();
    (changed.message[3] as any).status = 'Finishing';
    await expect(f.repository.reserveStatusIngress(1, changed)).rejects.toThrow('STATUS_INGRESS_IDENTITY_REUSED');
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it('new socket may reuse a CALL id while the old socket cannot reserve any new receipt', async () => {
    const f = fixture();
    const old = f.message();
    const first = await f.repository.reserveStatusIngress(1, old);
    f.activate('socket-b');
    const second = await f.repository.reserveStatusIngress(1, f.message());
    expect(second.id).toBeGreaterThan(first.id);
    await expect(f.repository.reserveStatusIngress(1, old)).rejects.toThrow('STATUS_INGRESS_RETIRED_CONNECTION');
    expect(f.rows).toHaveLength(2);
    expect(f.query).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE'), expect.objectContaining({
      replacements: { tenantId: 1, station: 'station', connection: 'socket-b' },
    }));
  });
});
