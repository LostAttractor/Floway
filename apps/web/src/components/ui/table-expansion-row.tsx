import type { ReactNode } from 'react';

import { ExpanderRegion } from './expander-region';
import { fluentComponents } from '../../fluent';

const { TableCell, TableRow, makeStyles } = fluentComponents;
const useStyles = makeStyles({ row: { height: 'auto', borderBottom: 'none', backgroundColor: 'transparent', ':hover': { backgroundColor: 'transparent' } }, cell: { padding: 0 } });

export function TableExpansionRow({ children, columns, open, onCollapsed }: { children: ReactNode; columns: number; open: boolean; onCollapsed: () => void }) {
  const styles = useStyles();
  return <TableRow className={styles.row}><TableCell className={styles.cell} colSpan={columns}>
    <ExpanderRegion open={open} onCollapsed={onCollapsed}>{children}</ExpanderRegion>
  </TableCell></TableRow>;
}
