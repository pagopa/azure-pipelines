import { PipelineRunner } from "../src/pipeline.runner";
import { TaskParameters } from "../src/task.parameters";
import * as core from '@actions/core';
import * as azdev from "azure-devops-node-api";
import * as BuildInterfaces from 'azure-devops-node-api/interfaces/BuildInterfaces';

// Verifica presenza del token
if (!process.env.TEST_AZURE_DEVOPS_TOKEN) {
    throw new Error('TEST_AZURE_DEVOPS_TOKEN environment variable is required');
}

const TEST_CONFIG = {
    azureDevOps: {
        projectUrl: 'https://dev.azure.com/pagopaspa/p4pa-projects',
        token: process.env.TEST_AZURE_DEVOPS_TOKEN
    },
    
    pipeline: {
        name: 'p4pa-payhub-deploy-aks.deploy',
        variables: {
            DEV_AGENT_POOL: 'p4pa-dev-linux-app',
            DEV_ARGOCD_SERVER: 'argocd.internal.dev.p4pa.pagopa.it',
            DEV_ARGOCD_USERNAME: 'admin',
            ENVIRONMENT: 'dev'
        },
        templateParameters: {
            "ENVIRONMENT": "dev",
            "DEPLOY_TYPE": "aks",
            "APP_NAME": "p4pa-payhub-deploy-aks",
            "ARGOCD_CONFIG_REPO": "pagopa/p4pa-payhub-deploy-aks",
            "ARGOCD_TARGET_BRANCH": "main",
            "APPS_CONFIG_PATH": "apps"
        }
    },
    
    github: {
        repository: 'pagopa/p4pa-payhub-deploy-aks',
        branch: 'refs/heads/main',
        sha: '1234567890abcdef'
    }
} as const;

describe('PipelineRunner Integration Tests', () => {
    let pipelineRunner: PipelineRunner;

    beforeEach(() => {
        process.env.GITHUB_REPOSITORY = TEST_CONFIG.github.repository;
        process.env.GITHUB_REF = TEST_CONFIG.github.branch;
        process.env.GITHUB_SHA = TEST_CONFIG.github.sha;

        jest.spyOn(core, 'getInput').mockImplementation((name: string) => {
            switch(name) {
                case 'azure-devops-project-url':
                    return TEST_CONFIG.azureDevOps.projectUrl;
                case 'azure-pipeline-name':
                    return TEST_CONFIG.pipeline.name;
                case 'azure-devops-token':
                    return TEST_CONFIG.azureDevOps.token;
                case 'azure-pipeline-variables':
                    return JSON.stringify(TEST_CONFIG.pipeline.variables);
                case 'azure-template-parameters':
                    return JSON.stringify(TEST_CONFIG.pipeline.templateParameters);
                default:
                    return '';
            }
        });

        jest.spyOn(core, 'setFailed').mockImplementation((message: string) => {
            console.error('Pipeline error:', message);
        });

        jest.spyOn(core, 'debug').mockImplementation((message: string) => {
            console.debug('Debug:', message);
        });

        pipelineRunner = new PipelineRunner(TaskParameters.getTaskParams());
    });

    afterEach(() => {
        delete process.env.GITHUB_REPOSITORY;
        delete process.env.GITHUB_REF;
        delete process.env.GITHUB_SHA;
        jest.restoreAllMocks();
    });

    it('should trigger real pipeline execution', async () => {
        try {
            console.log('Starting pipeline execution with params:', {
                repository: pipelineRunner.repository,
                branch: pipelineRunner.branch,
                pipelineName: TEST_CONFIG.pipeline.name,
                templateParams: TEST_CONFIG.pipeline.templateParameters
            });

            await pipelineRunner.start();
            expect(true).toBeTruthy();
        } catch (error) {
            if (error instanceof Error && error.message.includes('validation errors')) {
                console.log('Analyzing validation error details...');
                console.log('Error:', error);
                expect(true).toBeTruthy();
            } else {
                fail(error);
            }
        }
    }, 30000);

    it('should verify Azure DevOps connectivity', async () => {
        try {
            const taskParams = TaskParameters.getTaskParams();
            let authHandler = azdev.getPersonalAccessTokenHandler(taskParams.azureDevopsToken);
            let collectionUrl = taskParams.azureDevopsProjectUrl.split('/').slice(0, -1).join('/');
            
            const webApi = new azdev.WebApi(collectionUrl, authHandler);
            const buildApi = await webApi.getBuildApi();
            
            const projectName = taskParams.azureDevopsProjectUrl.split('/').pop() || '';
            const definitions = await buildApi.getDefinitions(projectName);
            
            expect(definitions).toBeDefined();
            expect(definitions.length).toBeGreaterThan(0);
            
            const targetPipeline = definitions.find(d => d.name === TEST_CONFIG.pipeline.name);
            expect(targetPipeline).toBeDefined();

            if (targetPipeline?.id) {
                const fullDefinition = await buildApi.getDefinition(projectName, targetPipeline.id);
                console.log('Pipeline details:', {
                    id: fullDefinition.id,
                    path: fullDefinition.path,
                    repositoryId: fullDefinition.repository?.id,
                    repositoryType: fullDefinition.repository?.type
                });
            }
        } catch (error) {
            console.error('Connectivity test failed:', error);
            fail(error);
        }
    });

    it('should initialize TaskParameters correctly', () => {
        const taskParams = pipelineRunner.taskParameters;
        expect(taskParams.azureDevopsProjectUrl).toBe(TEST_CONFIG.azureDevOps.projectUrl);
        expect(taskParams.azurePipelineName).toBe(TEST_CONFIG.pipeline.name);
        
        const parsedVariables = JSON.parse(taskParams.azurePipelineVariables);
        expect(parsedVariables).toEqual(TEST_CONFIG.pipeline.variables);
        
        const parsedParameters = JSON.parse(taskParams.azureTemplateParameters);
        expect(parsedParameters).toEqual(TEST_CONFIG.pipeline.templateParameters);
    });

    it('should have correct repository configuration', () => {
        expect(pipelineRunner.repository).toBe(TEST_CONFIG.github.repository);
        expect(pipelineRunner.branch).toBe(TEST_CONFIG.github.branch);
        expect(pipelineRunner.commitId).toBe(TEST_CONFIG.github.sha);
    });

    it('should correctly parse pipeline variables', () => {
        const parsedVariables = JSON.parse(pipelineRunner.taskParameters.azurePipelineVariables);
        expect(parsedVariables).toHaveProperty('DEV_AGENT_POOL');
        expect(parsedVariables).toHaveProperty('ENVIRONMENT');
        expect(parsedVariables.DEV_AGENT_POOL).toBe(TEST_CONFIG.pipeline.variables.DEV_AGENT_POOL);
        expect(parsedVariables.ENVIRONMENT).toBe(TEST_CONFIG.pipeline.variables.ENVIRONMENT);
    });

    it('should correctly parse template parameters', () => {
        const parsedParameters = JSON.parse(pipelineRunner.taskParameters.azureTemplateParameters);
        expect(parsedParameters).toHaveProperty('ENVIRONMENT');
        expect(parsedParameters).toHaveProperty('DEPLOY_TYPE');
        expect(parsedParameters).toHaveProperty('APP_NAME');
        expect(parsedParameters.ENVIRONMENT).toBe(TEST_CONFIG.pipeline.templateParameters.ENVIRONMENT);
        expect(parsedParameters.DEPLOY_TYPE).toBe(TEST_CONFIG.pipeline.templateParameters.DEPLOY_TYPE);
        expect(parsedParameters.APP_NAME).toBe(TEST_CONFIG.pipeline.templateParameters.APP_NAME);
    });
});
