import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as amplify from '@aws-cdk/aws-amplify-alpha';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { HotlineQaStack } from './hotline-qa-stack'; // Adjust path if needed

export class AmplifyHostingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps & { hotlineStack: HotlineQaStack }) {
    super(scope, id, props);

    const { hotlineStack } = props;

    // === Create API Gateway ===
    const api = new apigateway.RestApi(this, 'CounselorProfilesApi', {
      restApiName: 'Counselor Profiles Service',
      description: 'API for managing counselor profiles',
    });

    // === Integrate Lambda with API Gateway ===
    const manageProfilesIntegration = new apigateway.LambdaIntegration(hotlineStack.manageCounselorProfilesFunction);
    const profiles = api.root.addResource('profiles');
    profiles.addMethod('ANY', manageProfilesIntegration); // supports GET, POST, PUT

    // === Amplify App ===
    const amplifyApp = new amplify.App(this, 'HotlineFrontend', {
      sourceCodeProvider: new amplify.GitHubSourceCodeProvider({
        owner: 'ASUCICREPO',
        repository: 'Boys-Town-Hotline-QA',
        oauthToken: cdk.SecretValue.secretsManager('github-token-name'), // Store your token in Secrets Manager
      }),
      environmentVariables: {
        REACT_APP_API_URL: api.url, // makes it available as an env var to the frontend
      },
      buildSpec: amplify.BuildSpec.fromObjectToYaml({
        version: '1.0',
        frontend: {
          phases: {
            preBuild: {
              commands: ['npm ci'],
            },
            build: {
              commands: ['npm run build'],
            },
          },
          artifacts: {
            baseDirectory: 'build',
            files: ['**/*'],
          },
          cache: {
            paths: ['node_modules/**/*'],
          },
        },
      }),
    });

    amplifyApp.addBranch('main', {
      branchName: 'main',
      stage: 'PRODUCTION',
    });

    new cdk.CfnOutput(this, 'AmplifyAppUrl', {
      value: amplifyApp.defaultDomain,
      description: 'Default Amplify domain for the frontend app',
    });

    new cdk.CfnOutput(this, 'ApiGatewayUrl', {
      value: api.url,
      description: 'Base URL for the API Gateway exposing the counselor profiles function',
    });
  }
}
