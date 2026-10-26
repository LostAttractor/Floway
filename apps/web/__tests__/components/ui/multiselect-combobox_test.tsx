import { fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { MultiselectCombobox } from '../../../src/components/ui/multiselect-combobox';
import { renderInApp } from '../../render';

describe('multiselect combobox', () => {
  it('keeps a selected value operable after it leaves the available options', async () => {
    function Host() {
      const [value, setValue] = useState(['retired-model']);
      return <MultiselectCombobox
        ariaLabel="Models"
        clearLabel="All models"
        onChange={setValue}
        options={[{ value: 'current-model', label: 'Current model' }]}
        placeholder={value.length === 0 ? 'All models' : `${value.length} selected`}
        value={value}
      />;
    }

    renderInApp(<Host />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Models' }));

    expect(await screen.findByRole('menuitemcheckbox', { name: 'retired-model' })).toBeTruthy();
    const clear = screen.getByRole('menuitemcheckbox', { name: 'All models' });
    expect(clear.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(clear);
    expect(screen.getByRole<HTMLInputElement>('combobox', { name: 'Models' }).placeholder).toBe('All models');
    expect(screen.getByRole('menuitemcheckbox', { name: 'All models' }).getAttribute('aria-checked')).toBe('true');
  });

  it('keeps empty and prefix-like raw values separate from clear', () => {
    const onChange = vi.fn();
    function Host() {
      const [value, setValue] = useState<string[]>([]);
      return <MultiselectCombobox
        ariaLabel="Values"
        clearLabel="All values"
        onChange={next => { setValue(next); onChange(next); }}
        options={[{ value: '', label: 'Empty value' }, { value: ':', label: 'Colon value' }]}
        placeholder={`${value.length} selected`}
        value={value}
      />;
    }

    renderInApp(<Host />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Values' }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Empty value' }));
    expect(onChange).toHaveBeenLastCalledWith(['']);
    expect(screen.getByRole('menuitemcheckbox', { name: 'Empty value' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('menuitemcheckbox', { name: 'All values' }).getAttribute('aria-checked')).toBe('false');

    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Colon value' }));
    expect(onChange).toHaveBeenLastCalledWith(['', ':']);
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Empty value' }));
    expect(onChange).toHaveBeenLastCalledWith([':']);
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'All values' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(screen.getByRole('menuitemcheckbox', { name: 'All values' }).getAttribute('aria-checked')).toBe('true');
  });

  it('normalizes freeform entries without leaking option IDs', () => {
    const onChange = vi.fn();
    renderInApp(<MultiselectCombobox
      ariaLabel="Locations"
      freeform
      normalizeValue={entry => entry.trim().toUpperCase()}
      onChange={onChange}
      options={[{ value: 'SJC', label: 'SJC' }]}
      placeholder="Locations"
      value={['SJC']}
    />);
    const input = screen.getByRole('combobox', { name: 'Locations' });
    fireEvent.click(input);
    fireEvent.change(input, { target: { value: ' sin ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(['SJC', 'SIN']);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('selects a substring search result with Enter without activating clear', async () => {
    function Host() {
      const [value, setValue] = useState(['retired-model']);
      return <MultiselectCombobox
        ariaLabel="Models"
        clearLabel="All models"
        onChange={setValue}
        options={[{ value: 'current-model', label: 'Current model' }]}
        placeholder={`${value.length} selected`}
        value={value}
      />;
    }

    renderInApp(<Host />);
    const input = screen.getByRole('combobox', { name: 'Models' });
    fireEvent.click(input);
    fireEvent.change(input, { target: { value: 'urrent' } });
    expect(screen.queryByRole('menuitemcheckbox', { name: 'All models' })).toBeNull();
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(input.getAttribute('placeholder')).toBe('2 selected');
  });
});
