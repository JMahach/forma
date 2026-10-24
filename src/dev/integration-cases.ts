// Fixed synthetic states: no birth data, clock, network or saved charts.
export const INTEGRATION_GATES = [20, 10, 34, 57] as const;
// 0 empty, 1 design/red, 2 personality/black, 3 both.
const patterns = [
  '0000',
  '1000','2000','3000','0100','0200','0300',
  '0010','0020','0030','0001','0002','0003',
  '1200','0012','1020','1002','0120','0102',
  '1111','2222','3333',
  '1230','2130','3120','3210','0123','0213','0312','1233',
];
export const INTEGRATION_CASES = patterns.map((pattern, index) => ({
  id: index + 1, pattern,
  personality: INTEGRATION_GATES.filter((_, i) => Number(pattern[i]) & 2),
  design: INTEGRATION_GATES.filter((_, i) => Number(pattern[i]) & 1),
}));
