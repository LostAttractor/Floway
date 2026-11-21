import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { expect, test, vi } from 'vitest';

import type { UpstreamRecord } from '../../../src/api/types';
import { OutcomeToastProvider } from '../../../src/components/ui/outcome-toast';
import { UpstreamEditorPage } from '../../../src/components/upstream-editor/page';
import { i18n } from '../../../src/i18n';
import { upstreamRecord } from '../../api/upstream-fixture';
import { renderInApp } from '../../render';

const patch = vi.hoisted(() => vi.fn());
vi.mock('../../../src/api/client', () => ({
  api: { api: { upstreams: { ':id': { $patch: patch } } } },
  callApi: (operation: () => unknown) => operation(),
}));
vi.mock('../../../src/components/upstream-editor/provider-config', () => ({ ProviderConfigSection: () => null, ApiPathsSection: () => null }));
vi.mock('../../../src/components/upstream-editor/workspace', () => ({ UpstreamWorkspace: () => null }));

function renderEditor(record: UpstreamRecord) {
  patch.mockReset().mockImplementation(({ json }: { json: Pick<UpstreamRecord, 'service_tier_policy'> }) => ({
    data: { ...record, service_tier_policy: json.service_tier_policy }, error: null,
  }));
  const router = createMemoryRouter([{
    path: '/',
    element: <OutcomeToastProvider><UpstreamEditorPage data={{
      mode: 'edit', editLevel: 'full', record, discovered: null, proxies: [], runtime: { kind: 'node', runtimeLocation: 'TEST' },
    }} /></OutcomeToastProvider>,
  }]);
  renderInApp(<RouterProvider router={router} />);
}

const modeControl = () => screen.getByRole('combobox', { name: i18n.t('upstreams.editor.serviceTier.mode') });
const save = () => screen.getByRole<HTMLButtonElement>('button', { name: i18n.t('upstreams.editor.actions.save') });
const selectMode = async (label: string) => {
  fireEvent.click(modeControl());
  fireEvent.click(await screen.findByRole('option', { name: label }));
};
const savePolicy = async (policy: UpstreamRecord['service_tier_policy']) => {
  expect(save().disabled).toBe(false);
  fireEvent.click(save());
  await waitFor(() => expect(patch).toHaveBeenLastCalledWith({ param: { id: 'up_tier' }, json: expect.objectContaining({ service_tier_policy: policy }) }));
  await waitFor(() => expect(save().disabled).toBe(true));
};

test('ChatGPT saves inheritance as null and requires an operator-supplied tier when switching back on', async () => {
  const account = { email: null, chatgptAccountId: 'account', chatgptUserId: null, planType: 'pro' };
  renderEditor(upstreamRecord('up_tier', {
    kind: 'chatgpt', config: { accounts: [account] }, state: { accounts: [] }, service_tier_policy: { enabled: true, tiers: ['priority'] },
  }));
  const perModel = i18n.t('upstreams.editor.serviceTier.inheritPerModel');
  const invalid = i18n.t('upstreams.editor.serviceTier.invalid');

  await selectMode(perModel);
  expect(screen.getByText(i18n.t('upstreams.editor.serviceTier.chatgptHint'))).toBeTruthy();
  expect(screen.queryByRole('combobox', { name: i18n.t('upstreams.editor.serviceTier.tiers') })).toBeNull();
  await savePolicy(null);
  expect(modeControl().textContent).toBe(perModel);

  await selectMode(i18n.t('upstreams.editor.flags.on'));
  expect(await screen.findByText(invalid)).toBeTruthy();
  await act(async () => { fireEvent.click(save()); });
  expect(patch).toHaveBeenCalledTimes(1);
  const tiers = screen.getByRole('combobox', { name: i18n.t('upstreams.editor.serviceTier.tiers') });
  fireEvent.click(tiers);
  fireEvent.change(tiers, { target: { value: 'vendor/Tier' } });
  fireEvent.keyDown(tiers, { key: 'Enter' });
  fireEvent.keyDown(tiers, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByText(invalid)).toBeNull());
  await savePolicy({ enabled: true, tiers: ['vendor/Tier'] });

  await selectMode(i18n.t('upstreams.editor.flags.off'));
  await savePolicy({ enabled: false, tiers: ['vendor/Tier'] });
  await selectMode(perModel);
  await selectMode(i18n.t('upstreams.editor.flags.off'));
  await savePolicy({ enabled: false, tiers: [] });
});

test('Kimi Code still displays its inherited list and seeds explicit policies from it', async () => {
  renderEditor(upstreamRecord('up_tier', { kind: 'kimi-code', config: { region: 'china', apiKeySet: true }, state: null }));
  const on = i18n.t('upstreams.editor.flags.on');
  expect(modeControl().textContent).toBe(i18n.t('upstreams.editor.flags.inheritResolved', { state: on }));
  const tiers = screen.getByRole('combobox', { name: i18n.t('upstreams.editor.serviceTier.tiers') });
  fireEvent.click(tiers);
  expect((await screen.findByRole('menuitemcheckbox', { name: 'fast' })).getAttribute('aria-checked')).toBe('true');
  fireEvent.keyDown(tiers, { key: 'Escape' });
  expect(save().disabled).toBe(true);
  await selectMode(on);
  await savePolicy({ enabled: true, tiers: ['priority', 'fast', 'default', 'standard'] });
});
