<script>
import { components } from '@girder/components';
import NavigationBar from './NavigationBar.vue';

const { JobList } = components;

export default {
  name: 'Jobs',
  components: { NavigationBar, JobList },
};
</script>

<template>
  <v-main>
    <NavigationBar />
    <v-container>
      <JobList />
    </v-container>
  </v-main>
</template>
