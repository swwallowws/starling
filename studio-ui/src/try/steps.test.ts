import { describe, it, expect } from 'vitest';
import { recordLimit, micMessage } from './steps';

describe('try steps', () => {
  it('stops at ten seconds', () => {
    expect(recordLimit(9999)).toBe(false);
    expect(recordLimit(10000)).toBe(true);
  });
  it('explains a blocked mic', () => {
    expect(micMessage(new DOMException('x', 'NotAllowedError'))).toMatch(/blocked/);
    expect(micMessage(new DOMException('x', 'NotFoundError'))).toMatch(/No microphone/);
    expect(micMessage(new Error('x'))).toBe("Couldn't start the microphone.");
  });
});
