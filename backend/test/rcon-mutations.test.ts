import { describe, it, expect } from 'vitest';
import { interpretMutationAck, resolveMutation } from '../src/integrations/rcon/mutations';

describe('interpretMutationAck (real Build 42 replies)', () => {
  it('detects rejection from the actual server error strings', () => {
    const rejected = [
      "User zpanel_probe_nouser_xyz doesn't exist.", // kickuser
      'No such user', // additem / addxp
      'User "zpanel_probe_nouser_xyz" not found', // addvehicle
      'User zpanel_probe_nouser_xyz not found.', // powers
      'Unknown command "foo"',
    ];
    for (const s of rejected) expect(interpretMutationAck(s).accepted).toBe(false);
  });

  it('treats non-error replies as accepted', () => {
    const accepted = ['User x removed from white list', '', 'Kicked', 'OK', 'Vehicle spawned'];
    for (const s of accepted) expect(interpretMutationAck(s).accepted).toBe(true);
  });
});

describe('resolveMutation — honest {accepted, confirmed}', () => {
  it('rejected command -> accepted:false, confirmed:false (never runs verify)', async () => {
    let verified = false;
    const r = await resolveMutation('No such user', async () => {
      verified = true;
      return true;
    });
    expect(r).toMatchObject({ accepted: false, confirmed: false, confirmation: 'rejected' });
    expect(verified).toBe(false);
  });

  it('accepted + verified -> confirmed:true', async () => {
    const r = await resolveMutation('Kicked', async () => true);
    expect(r).toMatchObject({ accepted: true, confirmed: true, confirmation: 'verified' });
  });

  it('accepted but unverified -> confirmed:false, confirmation:unconfirmed', async () => {
    const r = await resolveMutation('Kicked', async () => false);
    expect(r).toMatchObject({ accepted: true, confirmed: false, confirmation: 'unconfirmed' });
  });

  it('accepted with no authoritative source -> unavailable, NEVER a blind {ok:true}', async () => {
    const r = await resolveMutation('anything');
    expect(r).toMatchObject({ accepted: true, confirmed: false, confirmation: 'unavailable' });
    expect(r).not.toHaveProperty('ok');
  });
});
