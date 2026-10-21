// A seated figure authored in the same 640 × 820 space as the chart.
// The two inner contours are the spaces between the arms and torso.
// This decorative surface does not define gate anchors or camera bounds.
export const LOTUS_BACKDROP_BOUNDS = Object.freeze({ x: 80, y: 80, width: 480, height: 690 });

export const LOTUS_SILHOUETTE_PATH = [
  // The Head center projects above the figure; keep the chart anchors fixed.
  'M 320 80',
  'C 282 80 258 104 258 142',
  'C 258 180 278 205 294 218',
  'C 298 224 298 229 296 233',
  'C 293 247 268 253 237 264',
  'C 211 273 198 292 190 320',
  'C 173 378 146 446 123 505',
  'C 112 532 95 559 87 582',
  'C 80 601 92 614 111 613',
  'C 124 613 139 604 151 596',
  'C 117 616 80 637 80 668',
  'C 80 708 143 738 204 755',
  'C 239 766 279 770 320 770',
  'C 361 770 401 766 436 755',
  'C 497 738 560 708 560 668',
  'C 560 637 523 616 489 596',
  'C 501 604 516 613 529 613',
  'C 548 614 560 601 553 582',
  'C 545 559 528 532 517 505',
  'C 494 446 467 378 450 320',
  'C 442 292 429 273 403 264',
  'C 372 253 347 247 344 233',
  'C 342 229 342 224 346 218',
  'C 362 205 382 180 382 142',
  'C 382 104 358 80 320 80 Z',
  // Open space separates each relaxed arm from the ribcage and waist.
  'M 224 333',
  'C 208 401 184 469 159 536',
  'C 154 549 147 563 140 573',
  'C 178 562 208 544 229 521',
  'C 246 501 248 478 243 449',
  'C 238 408 232 367 224 333 Z',
  'M 416 333',
  'C 432 401 456 469 481 536',
  'C 486 549 493 563 500 573',
  'C 462 562 432 544 411 521',
  'C 394 501 392 478 397 449',
  'C 402 408 408 367 416 333 Z',
].join(' ');

// A few quiet contour lines make the crossed shins and upturned feet legible
// without anatomical shading, a face or decorative marks competing with gates.
export const LOTUS_DETAIL_PATHS = Object.freeze([
  'M 105 657 C 131 632 169 626 203 637 C 247 651 277 688 317 702 C 357 716 405 707 440 681 C 448 675 448 667 440 663 C 425 656 405 664 391 672',
  'M 535 657 C 509 632 474 628 442 637 C 411 645 382 662 355 678',
  'M 500 706 C 467 730 417 742 370 739 C 321 736 278 706 234 686 C 219 679 200 675 190 683 C 184 689 191 697 202 701 C 218 707 236 708 252 706',
  'M 137 709 C 161 725 192 737 226 741',
]);
