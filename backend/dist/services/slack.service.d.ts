export declare class SlackService {
    private webhookUrl;
    constructor();
    sendPing(text: string): Promise<void>;
}
export declare const slackService: SlackService;
export default slackService;
