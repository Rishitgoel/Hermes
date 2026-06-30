import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { zookeeperService } from './zookeeper.service';
import config from '../config/config';

describe('ZookeeperService - Live Client NO_AUTH handling', () => {
  let simSpy: any;
  let clientSpy: any;

  beforeEach(() => {
    // Force live mode path (isSimulation = false)
    simSpy = vi.spyOn(config.zookeeper, 'isSimulation', 'get').mockReturnValue(false);
  });

  afterEach(() => {
    simSpy?.mockRestore();
    clientSpy?.mockRestore();
  });

  it('getChildren resolves to empty array on NO_AUTH error', async () => {
    const mockClient = {
      getChildren: vi.fn((path: string, cb: (err: any, children?: string[]) => void) => {
        cb({ code: -102, message: 'Exception: NO_AUTH[-102]' });
      }),
    };
    clientSpy = vi.spyOn(zookeeperService as any, 'getClient').mockResolvedValue(mockClient as any);

    const children = await zookeeperService.getChildren('/brokers');
    expect(children).toEqual([]);
    expect(mockClient.getChildren).toHaveBeenCalledWith('/brokers', expect.any(Function));
  });

  it('getData resolves to null on NO_AUTH error', async () => {
    const mockClient = {
      getData: vi.fn((path: string, cb: (err: any, data?: Buffer) => void) => {
        cb({ code: -102, message: 'Exception: NO_AUTH[-102]' });
      }),
    };
    clientSpy = vi.spyOn(zookeeperService as any, 'getClient').mockResolvedValue(mockClient as any);

    const data = await zookeeperService.getData('/brokers');
    expect(data).toBeNull();
    expect(mockClient.getData).toHaveBeenCalledWith('/brokers', expect.any(Function));
  });

  it('descendantPaths resolves to empty array on NO_AUTH error', async () => {
    const mockClient = {
      getChildren: vi.fn((path: string, cb: (err: any, children?: string[]) => void) => {
        cb({ code: -102, message: 'Exception: NO_AUTH[-102]' });
      }),
    };
    clientSpy = vi.spyOn(zookeeperService as any, 'getClient').mockResolvedValue(mockClient as any);

    const paths = await zookeeperService.descendantPaths('/brokers');
    expect(paths).toEqual([]);
    expect(mockClient.getChildren).toHaveBeenCalledWith('/brokers', expect.any(Function));
  });
});
