import { act, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import type { ComponentProps } from 'react';
import { createMemoryRouter, RouterProvider, UNSAFE_withComponentProps, useFetchers, useLoaderData, useNavigation, useOutlet } from 'react-router';
import { describe, expect, it } from 'vitest';

import { usePageFrames } from '../../src/components/page-frames';
import { OutcomeToastProvider } from '../../src/components/ui/outcome-toast';
import { pageNavigation } from '../../src/lib/page-navigation';
import DashboardMonitorRequests from '../../src/routes/dashboard-monitor-requests';
import DashboardProvidersProxy from '../../src/routes/dashboard-providers-proxy';
import { PAGE_LEAVE_ANIMATION } from '../../src/winui/page-transition.css';
import { renderInApp } from '../render';

// A page is held on screen while it leaves, and it is held so that what the
// operator was looking at is what fades out. That only works while React keeps
// the page mounted across the navigation: a page that remounts on its way out
// resets every `useState` it holds to whatever its loader data said when the
// page was entered, and any effect keyed on that state runs again with the
// reset value -- which is how the API keys page came to forget, and unpersist,
// the key that had just been picked.
const Page = () => {
  const [picked, setPicked] = useState('none');
  return <button onClick={() => setPicked('second')} type="button">{picked}</button>;
};

const RouterState = () => {
  const { label } = useLoaderData<{ label: string }>();
  const navigation = useNavigation();
  const fetchers = useFetchers();
  return <span data-route={label} data-navigation={navigation.state} data-fetchers={fetchers.length}>{label}</span>;
};

const Shell = () => {
  const frames = usePageFrames(useOutlet());
  return <>{frames.map(frame => <div data-leaving={frame.leaving} key={frame.id} onAnimationEnd={frame.onAnimationEnd}>{frame.node}</div>)}</>;
};

const renderRouter = () => {
  const router = createMemoryRouter([
    { path: '/', Component: Shell, children: [{ index: true, Component: Page }, { path: 'next', Component: Page }] },
  ], { initialEntries: ['/'] });
  return { router, ...renderInApp(<RouterProvider router={router} />) };
};

describe('page frames', () => {
  it('isolates the leaving route from subsequent navigation and fetcher updates', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const router = createMemoryRouter([{
      path: '/',
      Component: Shell,
      children: [
        { id: 'first', path: 'first', Component: RouterState, loader: () => ({ label: 'first' }) },
        { id: 'second', path: 'second', Component: RouterState, loader: () => ({ label: 'second' }) },
        { path: 'pending', Component: RouterState, loader: async () => { await pending; return { label: 'pending' }; } },
      ],
    }], { initialEntries: ['/first'] });
    let view!: ReturnType<typeof renderInApp>;
    await act(async () => { view = renderInApp(<RouterProvider router={router} />); });
    await act(async () => { await router.navigate('/second', pageNavigation); });

    let fetching!: Promise<void>;
    let navigating!: Promise<void>;
    try {
      await act(async () => {
        fetching = router.fetch('pending-fetch', 'second', '/pending');
        navigating = router.navigate('/pending', pageNavigation);
      });

      const leaving = view.container.querySelector('[data-leaving="true"] [data-route]');
      const current = view.container.querySelector('[data-leaving="false"] [data-route]');
      expect(leaving?.getAttribute('data-route')).toBe('first');
      expect(leaving?.getAttribute('data-navigation')).toBe('idle');
      expect(leaving?.getAttribute('data-fetchers')).toBe('0');
      expect(current?.getAttribute('data-route')).toBe('second');
      expect(current?.getAttribute('data-navigation')).toBe('loading');
      expect(current?.getAttribute('data-fetchers')).toBe('1');
    } finally {
      await act(async () => { release(); await Promise.all([fetching, navigating]); });
    }
  });

  it('retains the outgoing proxy page loader data when opening request monitoring', async () => {
    const router = createMemoryRouter([{
      path: '/',
      Component: Shell,
      children: [
        {
          path: 'proxy',
          loader: () => ({ proxies: [], backoffs: [], error: null }),
          Component: UNSAFE_withComponentProps(({ loaderData }: Pick<ComponentProps<typeof DashboardProvidersProxy>, 'loaderData'>) =>
            <DashboardProvidersProxy loaderData={loaderData} matches={[] as never} params={{}} />),
        },
        {
          path: 'requests',
          loader: () => ({
            collected: null, upstreamCollected: null, error: null, keys: [], record: null,
            recordError: null, records: [], recordsError: null, selectedKeyId: null,
          }),
          Component: UNSAFE_withComponentProps(({ loaderData }: Pick<ComponentProps<typeof DashboardMonitorRequests>, 'loaderData'>) =>
            <DashboardMonitorRequests loaderData={loaderData} matches={[] as never} params={{}} />),
        },
      ],
    }], { initialEntries: ['/proxy'] });
    let view!: ReturnType<typeof renderInApp>;
    await act(async () => { view = renderInApp(<OutcomeToastProvider><RouterProvider router={router} /></OutcomeToastProvider>); });
    const proxyPage = view.container.querySelector('[data-leaving="false"] section');
    expect(proxyPage).not.toBeNull();

    await act(async () => { await router.navigate('/requests', pageNavigation); });

    expect(view.container.querySelector('[data-leaving="true"] section')).toBe(proxyPage);
    expect(view.container.querySelector('[data-leaving="false"] section')).not.toBeNull();
  });

  it('keeps the leaving page mounted with the state it was drawn with', async () => {
    const { router, getByRole, container } = renderRouter();

    await act(async () => { getByRole('button').click(); });
    expect(getByRole('button').textContent).toBe('second');
    const held = getByRole('button');

    await act(async () => { await router.navigate('/next', pageNavigation); });

    const leaving = container.querySelector('[data-leaving="true"]');
    expect(leaving?.querySelector('button')).toBe(held);
    expect(leaving?.textContent).toBe('second');
  });

  // A request for reduced motion clamps the fade to 0.01ms, so anything that
  // held the frame for the unclamped length would keep an invisible copy of the
  // page -- effects, polling and all -- mounted long after it had gone.
  it('drops the leaving page when its fade ends, whatever that fade lasted', async () => {
    const { router, container } = renderRouter();

    await act(async () => { await router.navigate('/next', pageNavigation); });
    const leaving = container.querySelector('[data-leaving="true"]');
    if (!leaving) throw new Error('the navigation drew no leaving frame');
    const page = leaving.querySelector('button');
    if (!page) throw new Error('the leaving frame drew no page');

    // A page inside the frame animating is not the frame leaving.
    await act(async () => { fireEvent.animationEnd(page, { animationName: PAGE_LEAVE_ANIMATION }); });
    expect(container.querySelector('[data-leaving="true"]')).toBe(leaving);

    await act(async () => { fireEvent.animationEnd(leaving, { animationName: PAGE_LEAVE_ANIMATION }); });
    expect(container.querySelector('[data-leaving="true"]')).toBeNull();
  });

  // A page carries the mark on its own entry and replaces that entry when it
  // restates its URL, so the mark alone would make a filter change look like an
  // arrival: a new frame, and with it the page remounted from its loader data.
  it('draws no new frame when the page rewrites the entry it is already on', async () => {
    const { router, container } = renderRouter();
    const currentButton = () => {
      const button = container.querySelector<HTMLButtonElement>('[data-leaving="false"] button');
      if (!button) throw new Error('the current frame drew no page');
      return button;
    };

    await act(async () => { await router.navigate('/next', pageNavigation); });
    await act(async () => { currentButton().click(); });
    const held = currentButton();

    await act(async () => { await router.navigate('/next?range=7d', { ...pageNavigation, replace: true }); });

    expect(container.querySelector('[data-leaving="true"]')).toBeNull();
    expect(currentButton()).toBe(held);
    expect(held.textContent).toBe('second');
  });
});
