import { registerAs } from '@nestjs/config';
 

export interface IKeyServerConfig {
  signingKeyAsHEx: string;
  signingIvAsHex: string;
  signer: string;
  keyServerUrl: string;
}

export default registerAs(
  'keyServerConfig',
  (): IKeyServerConfig => ({
    signingKeyAsHEx: process.env.WIDEVINE_SIGNING_KEY,
    signingIvAsHex: process.env.WIDEVINE_SIGNING_IV,
    signer: process.env.WIDEVINE_PROVIDER_NAME,
    keyServerUrl: process.env.KEY_SERVER_URL,
  }),
);
