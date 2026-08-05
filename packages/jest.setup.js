/**
 * Jest setup for the packages workspace.
 *
 * Gate 4 and gate 1 log every rejection by design, which is right in production
 * and unreadable in a suite that deliberately triggers hundreds of rejections.
 * The logs are captured rather than discarded, so a test can still assert on
 * them via `expect(console.warn).toHaveBeenCalledWith(...)`, and a genuinely
 * unexpected error is still visible by inspecting the mock.
 *
 * console.error is left alone: nothing in the suite should be producing errors,
 * so if one appears it should be loud.
 */

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});
