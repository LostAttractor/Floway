import { fireEvent, screen, waitFor } from '@testing-library/react';
import { FormProvider, useForm, useWatch } from 'react-hook-form';
import { expect, test, vi } from 'vitest';

import { UpstreamConfigSidebar } from '../../../src/components/upstream-editor/config-sidebar';
import { valuesFromRecord, type UpstreamEditorValues } from '../../../src/components/upstream-editor/data';
import { i18n } from '../../../src/i18n';
import { upstreamRecord } from '../../api/upstream-fixture';
import { renderInApp } from '../../render';

vi.mock('../../../src/components/upstream-editor/provider-config', () => ({ ProviderConfigSection: () => null, ApiPathsSection: () => null }));

const account = { email: 'local@example.invalid', chatgptAccountId: 'account', chatgptUserId: null, planType: 'pro' };
const record = upstreamRecord('up_tier', { kind: 'codex', config: { accounts: [account] }, state: { accounts: [] }, service_tier_policy: null });

function Harness({ policy = null }: { policy?: UpstreamEditorValues['serviceTierPolicy'] }) {
  const form = useForm<UpstreamEditorValues>({ defaultValues: valuesFromRecord({ ...record, service_tier_policy: policy }) });
  const value = useWatch({ control: form.control, name: 'serviceTierPolicy' });
  return <FormProvider {...form}>
    <button type="button" onClick={() => form.setValue('config', { accounts: [{ ...account, planType: 'free' }] })}>Observe Free</button>
    <button type="button" onClick={() => form.setValue('config', { accounts: [account] })}>Observe Pro</button>
    <output data-testid="stored-policy">{JSON.stringify(value)}</output>
    <output data-testid="policy-dirty">{String(Boolean(form.formState.dirtyFields.serviceTierPolicy))}</output>
    <UpstreamConfigSidebar catalogAvailable={false} discovered={[]} editLevel="full" onPatch={() => {}} onRefreshModels={() => {}} proxies={[]} record={record} runtime={{ kind: 'node', runtimeLocation: 'TEST' }} />
  </FormProvider>;
}

const modeControl = () => screen.getByRole('combobox', { name: i18n.t('dashboard.upstreamEditor.serviceTier.mode') });
const selectMode = async (label: string) => {
  fireEvent.click(modeControl());
  fireEvent.click(await screen.findByRole('option', { name: label }));
};
const defaultLabel = () => i18n.t('dashboard.upstreamEditor.flags.inheritResolved', { state: i18n.t('dashboard.upstreamEditor.flags.off') });
const openTiers = () => fireEvent.click(screen.getByRole('combobox', { name: i18n.t('dashboard.upstreamEditor.serviceTier.tiers') }));

test('default mode derives suggestions without writing or dirtying the policy', async () => {
  renderInApp(<Harness />);
  expect(modeControl().textContent).toContain(defaultLabel());
  openTiers();
  expect((await screen.findByRole('menuitemcheckbox', { name: 'priority' })).getAttribute('aria-checked')).toBe('true');
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.getByTestId('stored-policy').textContent).toBe('null');
  expect(screen.getByTestId('policy-dirty').textContent).toBe('false');
  fireEvent.click(screen.getByRole('button', { name: 'Observe Free' }));
  openTiers();
  expect(screen.queryByRole('menuitemcheckbox', { name: 'priority' })).toBeNull();
  expect(screen.getByTestId('stored-policy').textContent).toBe('null');
});

test('on and off create explicit policies; Default restores inheritance', async () => {
  renderInApp(<Harness />);
  await selectMode(i18n.t('dashboard.upstreamEditor.flags.on'));
  await waitFor(() => expect(screen.getByTestId('stored-policy').textContent).toBe(JSON.stringify({ enabled: true, tiers: ['priority'] })));
  fireEvent.click(screen.getByRole('button', { name: 'Observe Free' }));
  expect(screen.getByTestId('stored-policy').textContent).toBe(JSON.stringify({ enabled: true, tiers: ['priority'] }));
  await selectMode(i18n.t('dashboard.upstreamEditor.flags.off'));
  expect(screen.getByTestId('stored-policy').textContent).toBe(JSON.stringify({ enabled: false, tiers: ['priority'] }));
  await selectMode(defaultLabel());
  expect(screen.getByTestId('stored-policy').textContent).toBe('null');
  fireEvent.click(screen.getByRole('button', { name: 'Observe Pro' }));
  openTiers();
  expect((await screen.findByRole('menuitemcheckbox', { name: 'priority' })).getAttribute('aria-checked')).toBe('true');
});

test('clearing inherited suggestions creates an explicit empty override', async () => {
  renderInApp(<Harness />);
  openTiers();
  fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'priority' }));
  expect(screen.getByTestId('stored-policy').textContent).toBe(JSON.stringify({ enabled: false, tiers: [] }));
  fireEvent.click(screen.getByRole('button', { name: 'Observe Free' }));
  fireEvent.click(screen.getByRole('button', { name: 'Observe Pro' }));
  expect(screen.getByTestId('stored-policy').textContent).toBe(JSON.stringify({ enabled: false, tiers: [] }));
});
