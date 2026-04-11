import { fetch } from '../index';
import { installFetchImplementation } from '../../utils/install';

installFetchImplementation(globalThis as Record<string, unknown>, fetch, {
  installWebApis: 'always',
  overwriteFetch: true,
});

export {};
