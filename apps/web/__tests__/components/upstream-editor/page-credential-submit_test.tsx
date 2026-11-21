import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useFormContext, useWatch } from 'react-hook-form';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, expect, test, vi } from 'vitest';

import type { UpstreamRecord } from '../../../src/api/types';
import { OutcomeToastProvider } from '../../../src/components/ui/outcome-toast';
import type { UpstreamEditorValues } from '../../../src/components/upstream-editor/data';
import { UpstreamEditorPage } from '../../../src/components/upstream-editor/page';
import { observedPlanType } from '../../../src/components/upstreams/chatgpt-account';
import { i18n } from '../../../src/i18n';
import { upstreamRecord } from '../../api/upstream-fixture';
import { renderInApp } from '../../render';

const apiMocks = vi.hoisted(() => ({ create: vi.fn(), patch: vi.fn(), importCredential: vi.fn() }));

vi.mock('../../../src/api/client', () => ({
  api: { api: { upstreams: { $post: apiMocks.create, ':id': { $patch: apiMocks.patch } } } },
  callApi: (operation: () => unknown) => operation(),
}));

const imported = {
  config: { accounts: [{ email: 'operator@example.com', chatgptAccountId: null, chatgptUserId: null, planType: 'free' }] },
  state: {
    accounts: [{
      chatgptAccountId: null,
      refresh_token: 'refresh-token',
      state: 'active' as const,
      state_updated_at: '2026-09-30T00:00:00.000Z',
      openaiDeviceId: 'device-id',
      accessToken: null,
      quotaSnapshot: null,
    }],
  },
};

vi.mock('../../../src/components/upstream-editor/config-sidebar', () => ({
  UpstreamConfigSidebar: ({ onPatch, record }: {
    onPatch: (patch: { config?: unknown; state?: unknown }, persisted: boolean) => void;
    record: UpstreamRecord;
  }) => {
    const { setValue } = useFormContext<UpstreamEditorValues>();
    const policy = useWatch<UpstreamEditorValues>({ name: 'serviceTierPolicy' });
    const name = useWatch({ name: 'name' });
    return <>
      <button type="button" onClick={() => onPatch(imported, record.id !== '')}>Import credential</button>
      <button type="button" onClick={() => { void apiMocks.importCredential().then((patch: typeof imported) => onPatch(patch, record.id !== '')); }}>Import delayed credential</button>
      <button type="button" onClick={() => onPatch({ ...imported, config: { accounts: [{ ...imported.config.accounts[0], planType: 'pro' }] } }, record.id !== '')}>Import paid credential</button>
      <button type="button" onClick={() => setValue('serviceTierPolicy', { enabled: false, tiers: [] }, { shouldDirty: true, shouldTouch: true })}>Clear tiers</button>
      <button type="button" onClick={() => setValue('serviceTierPolicy', null, { shouldDirty: true, shouldTouch: true })}>Restore unset policy</button>
      <button type="button" onClick={() => setValue('config', imported.config, { shouldDirty: true })}>Edit credential draft</button>
      <button type="button" onClick={() => setValue('name', 'Unsaved name', { shouldDirty: true })}>Edit name</button>
      <button type="button" onClick={() => onPatch({ state: { accounts: [{ ...imported.state.accounts[0], accessToken: { token: 'test-token', expiresAt: null, refreshedAt: '2026-10-27T00:00:00Z', planType: 'free' } }] } }, true)}>Refresh observed plan</button>
      <output data-testid="name-draft">{name}</output>
      <output data-testid="tier-policy">{JSON.stringify(policy)}</output>
      <output data-testid="observed-plan">{record.kind === 'chatgpt' && observedPlanType(record)}</output>
    </>;
  },
}));

vi.mock('../../../src/components/upstream-editor/workspace', () => ({ UpstreamWorkspace: () => null }));

const blueprint = upstreamRecord('', { kind: 'chatgpt', config: { accounts: [] }, state: { accounts: [] } });

const renderPage = (record: UpstreamRecord, mode: 'create' | 'edit') => {
  const router = createMemoryRouter([
    {
      path: '/editor',
      element: <OutcomeToastProvider><UpstreamEditorPage data={{
        mode, editLevel: 'full', record, discovered: null, proxies: [], runtime: { kind: 'node', runtimeLocation: 'TEST' },
      }} /></OutcomeToastProvider>,
    },
    { path: '/dashboard/providers/upstreams/:id', element: <div>Saved upstream</div> },
  ], { initialEntries: ['/editor'] });
  return renderInApp(<RouterProvider router={router} />);
};

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.create.mockResolvedValue({ data: { ...blueprint, id: 'up_chatgpt', ...imported }, error: null });
});

test('creating a ChatGPT upstream saves the imported credential', async () => {
  renderPage(blueprint, 'create');
  fireEvent.click(screen.getByRole('button', { name: 'Import credential' }));
  fireEvent.click(screen.getByRole('button', { name: i18n.t('upstreams.editor.actions.save') }));

  await waitFor(() => expect(apiMocks.create).toHaveBeenCalledWith({
    json: expect.objectContaining({
      kind: 'chatgpt',
      config: imported.config,
      state: imported.state,
    }),
  }));
  expect(screen.queryByText(i18n.t('upstreams.editor.fetchDirty.unsavedCredential'))).toBeNull();
});

test('new ChatGPT drafts keep tier inheritance across credential imports and save it as null', async () => {
  renderPage(blueprint, 'create');
  fireEvent.click(screen.getByRole('button', { name: 'Import paid credential' }));
  expect(screen.getByTestId('observed-plan').textContent).toBe('pro');
  expect(screen.getByTestId('tier-policy').textContent).toBe('null');
  fireEvent.click(screen.getByRole('button', { name: 'Import credential' }));
  expect(screen.getByTestId('observed-plan').textContent).toBe('free');
  expect(screen.getByTestId('tier-policy').textContent).toBe('null');
  fireEvent.click(screen.getByRole('button', { name: 'Import paid credential' }));
  fireEvent.click(screen.getByRole('button', { name: i18n.t('upstreams.editor.actions.save') }));
  await waitFor(() => expect(apiMocks.create).toHaveBeenCalledWith({
    json: expect.objectContaining({ service_tier_policy: null }),
  }));
});

test.each(['Clear tiers', 'Restore unset policy'])('credential import does not overwrite a manual change during its wait: %s', async action => {
  let finish!: (patch: typeof imported) => void;
  apiMocks.importCredential.mockReturnValue(new Promise<typeof imported>(resolve => { finish = resolve; }));
  renderPage(blueprint, 'create');
  fireEvent.click(screen.getByRole('button', { name: 'Import delayed credential' }));
  fireEvent.click(screen.getByRole('button', { name: action }));
  await act(async () => { finish({ ...imported, config: { accounts: [{ ...imported.config.accounts[0], planType: 'pro' }] } }); });
  expect(screen.getByTestId('tier-policy').textContent).toBe(JSON.stringify(action === 'Clear tiers' ? { enabled: false, tiers: [] } : null));
});

test.each([null, { enabled: false, tiers: [] }, { enabled: true, tiers: ['custom'] }])('existing records retain policy on credential import: %j', service_tier_policy => {
  renderPage({ ...blueprint, id: 'up_chatgpt', service_tier_policy }, 'edit');
  fireEvent.click(screen.getByRole('button', { name: 'Import paid credential' }));
  expect(screen.getByTestId('tier-policy').textContent).toBe(JSON.stringify(service_tier_policy));
});

test.each([{ enabled: false, tiers: [] }, { enabled: true, tiers: ['custom'] }])('copied explicit policies survive new credentials: %j', service_tier_policy => {
  renderPage({ ...blueprint, service_tier_policy }, 'create');
  fireEvent.click(screen.getByRole('button', { name: 'Import paid credential' }));
  expect(screen.getByTestId('tier-policy').textContent).toBe(JSON.stringify(service_tier_policy));
});

test('a state-only refresh updates the observed plan without changing tier inheritance or unsaved fields', () => {
  renderPage({ ...blueprint, id: 'up_chatgpt', kind: 'chatgpt', config: { accounts: [{ ...imported.config.accounts[0], planType: 'pro' }] }, state: imported.state }, 'edit');
  expect(screen.getByTestId('observed-plan').textContent).toBe('pro');
  fireEvent.click(screen.getByRole('button', { name: 'Edit name' }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh observed plan' }));
  expect(screen.getByTestId('observed-plan').textContent).toBe('free');
  expect(screen.getByTestId('tier-policy').textContent).toBe('null');
  expect(screen.getByTestId('name-draft').textContent).toBe('Unsaved name');
});

test('editing a saved ChatGPT upstream still rejects unsaved credential changes', async () => {
  renderPage({ ...blueprint, id: 'up_chatgpt' }, 'edit');
  fireEvent.click(screen.getByRole('button', { name: 'Edit credential draft' }));
  fireEvent.click(screen.getByRole('button', { name: i18n.t('upstreams.editor.actions.save') }));

  expect(await screen.findByText(i18n.t('upstreams.editor.fetchDirty.unsavedCredential'))).toBeTruthy();
  expect(apiMocks.patch).not.toHaveBeenCalled();
});
