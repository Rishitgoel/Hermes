import dotenv from 'dotenv';
import path from 'path';

// Load the .env file from the backend root
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { awsIdentityCenterService } from '../src/services/aws-identity-center.service';
import config from '../src/config/config';

async function testAwsConnection() {
  console.log('=== AWS IAM Identity Center Integration Test ===\n');

  console.log('Configuration Loaded:');
  console.log(`- NODE_ENV: ${config.nodeEnv}`);
  console.log(`- AWS_SIMULATION: ${config.aws.isSimulation}`);
  console.log(`- AWS_REGION: ${config.aws.region || 'Not set'}`);
  console.log(`- AWS_IDENTITY_CENTER_REGION: ${config.aws.identityCenterRegion || 'Not set'}`);
  console.log(`- AWS_IDENTITY_STORE_ID: ${config.aws.identityStoreId || 'Not set'}`);
  console.log(`- AWS_PROFILE: ${process.env.AWS_PROFILE || 'Not set'}`);
  console.log('');

  if (config.aws.isSimulation) {
    console.error('❌ Error: AWS_SIMULATION is set to true (or AWS_IDENTITY_STORE_ID is missing).');
    console.error('Please update your backend/.env file to set:');
    console.error('  AWS_SIMULATION=false');
    console.error('  AWS_IDENTITY_STORE_ID=d-xxxxxxxxxx (your Identity Store ID)');
    console.error('  AWS_PROFILE=APIAdministratorAccess-164733188212');
    process.exit(1);
  }

  console.log('Attempting to connect to AWS Identity Store...');
  try {
    const health = await awsIdentityCenterService.healthCheck();
    if (health.healthy) {
      console.log('✅ Health check succeeded! Connection is live.');
    } else {
      console.error(`❌ Health check failed: ${health.message}`);
      process.exit(1);
    }

    console.log('\nFetching groups from Identity Store...');
    const groups = await awsIdentityCenterService.listGroups();
    console.log(`✅ Successfully fetched ${groups.length} group(s):`);
    for (const group of groups) {
      console.log(`   - Group Name: "${group.displayName}" (ID: ${group.groupId})`);
    }

    console.log('\nFetching users from Identity Store...');
    const users = await awsIdentityCenterService.listUsers();
    console.log(`✅ Successfully fetched ${users.length} user(s):`);
    for (const user of users) {
      console.log(`   - Username/Email: "${user.userName}" (ID: ${user.userId})`);
    }

    console.log('\n🎉 AWS Identity Center API Integration is fully working!');

  } catch (error: any) {
    console.error('\n❌ An error occurred while testing the APIs:');
    console.error(error);
    process.exit(1);
  }
}

testAwsConnection();
