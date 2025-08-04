const API_URL = `${process.env.REACT_APP_API_URL}/get-data` || 'https://td86a455og.execute-api.us-east-1.amazonaws.com/prod/get-data';
const PROFILES_API_URL = `${process.env.REACT_APP_API_URL}/profiles` || 'https://td86a455og.execute-api.us-east-1.amazonaws.com/prod/profiles';

// Local storage for agent programs
const AGENT_PROGRAMS_KEY = 'agent_programs';

// Helper function to get stored programs for an agent (localStorage)
const getStoredPrograms = (counselorId) => {
  const stored = localStorage.getItem(AGENT_PROGRAMS_KEY);
  const programs = stored ? JSON.parse(stored) : {};
  return programs[counselorId] || [];
};

// Get counselor programs from API (with localStorage fallback)
const getCounselorPrograms = async (counselorId) => {
  try {
    const response = await fetch(`${PROFILES_API_URL}/${counselorId}`);
    if (response.ok) {
      const profile = await response.json();
      // Convert comma-separated string back to array
      if (profile.ProgramType && typeof profile.ProgramType === 'string') {
        return profile.ProgramType.split(', ').filter(p => p.trim() !== '');
      }
      return profile.ProgramType || [];
    }
  } catch (error) {
    console.log('Failed to fetch programs from API, using localStorage:', error);
  }
  
  // Fallback to localStorage
  return getStoredPrograms(counselorId);
};

// Helper function to store programs for an agent
const storePrograms = (counselorId, programs) => {
  const stored = localStorage.getItem(AGENT_PROGRAMS_KEY);
  const allPrograms = stored ? JSON.parse(stored) : {};
  allPrograms[counselorId] = programs;
  localStorage.setItem(AGENT_PROGRAMS_KEY, JSON.stringify(allPrograms));
};

// Process agent data from API response
const processAgentData = async (data) => {
  // Group by counselorId
  const counselorGroups = {};
  
  data.forEach(entry => {
    const { CounselorId, CounselorName, PercentageScore, TotalScore, EvaluationDate } = entry;
    const evalDate = new Date(EvaluationDate);
    const isFirstHalf = evalDate.getMonth() < 6; // First half: Jan-Jun, Second half: Jul-Dec
    
    if (!counselorGroups[CounselorId]) {
      counselorGroups[CounselorId] = {
        name: CounselorName,
        contactId: CounselorId,
        programs: [], // Will be populated from API
        specialization: 'No programs assigned',
        totalCases: 0,
        evaluations: [],
        firstHalfScores: [],
        secondHalfScores: []
      };
    }
    
    counselorGroups[CounselorId].totalCases += 1;
    
    // Add score to appropriate half-year array
    if (isFirstHalf) {
      counselorGroups[CounselorId].firstHalfScores.push(PercentageScore);
    } else {
      counselorGroups[CounselorId].secondHalfScores.push(PercentageScore);
    }
    
    counselorGroups[CounselorId].evaluations.push({
      fileName: entry.AudioFileName,
      date: new Date(EvaluationDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      score: `${Math.round(TotalScore || 0)} / 92`, // Use TotalScore instead of PercentageScore
      categoryScores: entry.CategoryScores
    });
  });
  
  // Calculate half-year averages and load programs from API
  const counselorArray = await Promise.all(
    Object.values(counselorGroups).map(async (agent) => {
      // Calculate first half average
      if (agent.firstHalfScores.length > 0) {
        const sum = agent.firstHalfScores.reduce((acc, score) => acc + score, 0);
        agent.firstHalfAvg = Math.round(sum / agent.firstHalfScores.length);
      } else {
        agent.firstHalfAvg = 'N/A';
      }
      
      // Calculate second half average
      if (agent.secondHalfScores.length > 0) {
        const sum = agent.secondHalfScores.reduce((acc, score) => acc + score, 0);
        agent.secondHalfAvg = Math.round(sum / agent.secondHalfScores.length);
      } else {
        agent.secondHalfAvg = 'N/A';
      }
      
      // Load programs from API
      agent.programs = await getCounselorPrograms(agent.contactId);
      agent.specialization = agent.programs.length > 0 ? agent.programs.join(', ') : 'No programs assigned';
      
      // Clean up temporary arrays
      delete agent.firstHalfScores;
      delete agent.secondHalfScores;
      
      return agent;
    })
  );
  
  return counselorArray;
};

// Fetch all agents data
const getAllAgents = async () => {
  try {
    const response = await fetch(API_URL);
    if (!response.ok) {
      throw new Error(`API request failed with status ${response.status}`);
    }
    const data = await response.json();
    //console.log('API Response:', data);
    
    const processedData = await processAgentData(data);
    //console.log('Processed Agent Data:', processedData);
    
    return processedData;
  } catch (error) {
    console.error('Error fetching agent data:', error);
    return [];
  }
};

// Get a specific agent by ID
const getAgentById = async (agentId) => {
  try {
    const allAgents = await getAllAgents();
    return allAgents.find(agent => agent.contactId === agentId) || null;
  } catch (error) {
    console.error(`Error fetching agent with ID ${agentId}:`, error);
    return null;
  }
};

// Update agent programs
const updateAgentPrograms = async (agentId, programs) => {
  try {
    // First, try to get the existing counselor profile
    let counselorProfile;
    try {
      const getResponse = await fetch(`${PROFILES_API_URL}/${agentId}`);
      if (getResponse.ok) {
        counselorProfile = await getResponse.json();
      }
    } catch (getError) {
      console.log('Counselor profile not found, will create new one');
    }

    // Prepare the profile data (using camelCase as expected by Lambda)
    // Convert programs array to comma-separated string for DynamoDB
    const profileData = {
      counselorId: agentId,
      counselorName: counselorProfile?.CounselorName || `Counselor ${agentId}`,
      programType: programs.join(', '), // Convert array to string
      isActive: true,
      lastUpdated: new Date().toISOString(),
      updatedBy: 'Frontend User'
    };

    // If profile exists, update it; otherwise create it
    const method = counselorProfile ? 'PUT' : 'POST';
    const url = counselorProfile ? `${PROFILES_API_URL}/${agentId}` : PROFILES_API_URL;

    const response = await fetch(url, {
      method: method,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(profileData)
    });

    if (!response.ok) {
      throw new Error(`Failed to update counselor programs: ${response.status}`);
    }

    const result = await response.json();
    console.log('Successfully updated counselor programs:', result);

    // Also store in localStorage as backup
    storePrograms(agentId, programs);
    
    return programs;
  } catch (error) {
    console.error('Error updating agent programs:', error);
    
    // Fallback to localStorage if API fails
    storePrograms(agentId, programs);
    return programs;
  }
};

export const agentService = {
  getAllAgents,
  getAgentById,
  updateAgentPrograms
};