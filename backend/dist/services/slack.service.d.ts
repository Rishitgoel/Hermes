export declare class SlackService {
    private webhookUrl;
    private client;
    constructor();
    sendPing(text: string): Promise<void>;
}
export declare const slackService: SlackService;
export default slackService;
