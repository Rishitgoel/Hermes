export declare const config: {
    readonly nodeEnv: string;
    readonly port: number;
    readonly isDev: boolean;
    readonly isProd: boolean;
    readonly isSimulation: boolean;
    readonly keycloak: {
        readonly jwksUri: string;
        readonly issuer: string;
        readonly audience: string | undefined;
        readonly adminUrl: string;
        readonly adminClientId: string;
        readonly adminUsername: string;
        readonly adminPassword: string | undefined;
        readonly realm: string;
    };
    readonly redash: {
        readonly baseUrl: string;
        readonly apiKey: string;
        readonly isSimulation: boolean;
    };
    readonly slack: {
        readonly webhookUrl: string | undefined;
    };
    readonly aws: {
        readonly region: string | undefined;
        readonly accessKeyId: string | undefined;
        readonly secretAccessKey: string | undefined;
        readonly secretName: string;
    };
    readonly frontend: {
        readonly url: string;
        readonly allowedOrigins: string[];
    };
    readonly rateLimiting: {
        readonly enabled: boolean;
    };
    readonly security: {
        readonly enableHelmet: boolean;
    };
};
export default config;
