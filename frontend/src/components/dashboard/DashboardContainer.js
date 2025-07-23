import { useState, useEffect } from 'react';
import './DashboardContainer.css';
import AgentCard from '../AgentCard';
import AgentDetails from '../AgentDetails';
import { agentService } from '../../services/agentService';

const imgEllipse1 = "http://localhost:3845/assets/dcc912ce11c40eac810e7d22fb275abb31670d4b.svg";
const imgEllipse2 = "http://localhost:3845/assets/94538a1e7a646e4519925df62f18476b373c5bee.svg";
const imgEllipse3 = "http://localhost:3845/assets/721109041c9a688b03535beb6d7d05ad3685a5fa.svg";
const imgDropdownArrow = "http://localhost:3845/assets/5356d5889cbe72300bc2c08be7daa8190ccab606.svg";
const imgWestArrow = "http://localhost:3845/assets/dab477c6ade2d19b6d463e2d6994e32669d7440c.svg";
const imgWestIcon = "http://localhost:3845/assets/9fc49a8ad4582ec588abb9db25500f5811dbc74c.svg";
const imgCall = "http://localhost:3845/assets/ef6e5e33bf0c7a55016af261878a9906b26dd5b9.svg";
const imgCallIcon = "http://localhost:3845/assets/20f6037d1e0458230bce762850b2ffc99fe936cb.svg";
const imgLine = "http://localhost:3845/assets/3873aadcd49ad269806198541057edcaf8fbb825.svg";
const imgLine10 = "http://localhost:3845/assets/617d77add44dc3b59a619850aa9fc52a5d3b4974.svg";
const imgLine14 = "http://localhost:3845/assets/9082e57296c9ee82cca1c2ee794dfcdd9f9129df.svg";
const imgPerson = "http://localhost:3845/assets/627d492e7c95cfbccc4574266f4dce2d0ee267c5.svg";

function DashboardContainer() {
  const [selectedFilter, setSelectedFilter] = useState('All');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  
  // Fetch agents data when component mounts
  useEffect(() => {
    const fetchAgents = async () => {
      setLoading(true);
      try {
        const agentsData = await agentService.getAllAgents();
        
        // Assign avatars to agents
        const avatars = [imgEllipse1, imgEllipse2, imgEllipse3];
        const agentsWithAvatars = agentsData.map((agent, index) => ({
          ...agent,
          avatar: avatars[index % avatars.length]
        }));
        
        setAgents(agentsWithAvatars);
      } catch (error) {
        console.error('Error fetching agents:', error);
      } finally {
        setLoading(false);
      }
    };
    
    fetchAgents();
  }, []);

  // Get unique programs for filter dropdown
  const programs = ['All', 'National Hotline Program', 'Nebraska Crisis Program'];
  
  const filteredAgents = selectedFilter === 'All' 
    ? agents 
    : agents.filter(agent => agent.specialization === selectedFilter);

  const handleAgentClick = async (agent) => {
    // Get detailed agent data including evaluations
    const detailedAgent = await agentService.getAgentById(agent.contactId);
    setSelectedAgent({
      ...agent,
      evaluations: detailedAgent?.evaluations || []
    });
  };

  const handleBackClick = () => {
    setSelectedAgent(null);
  };

  const handleFilterSelect = (filter) => {
    setSelectedFilter(filter);
    setIsDropdownOpen(false);
  };

  return (
    <div className="dashboard-page">
      {selectedAgent ? (
        <AgentDetails agent={selectedAgent} onBack={handleBackClick} />
      ) : (
        <>
          <div className="filter-dropdown">
            <button 
              className="filter-btn" 
              onClick={() => setIsDropdownOpen(!isDropdownOpen)}
            >
              <span>FILTER</span>
              <img src={imgDropdownArrow} alt="" className="dropdown-arrow" />
            </button>
            {isDropdownOpen && (
              <div className="dropdown-menu">
                {programs.map(program => (
                  <div
                    key={program}
                    className={`dropdown-item ${selectedFilter === program ? 'active' : ''}`}
                    onClick={() => handleFilterSelect(program)}
                  >
                    {program}
                  </div>
                ))}
              </div>
            )}
          </div>
          
          <div className="agents-grid">
            {filteredAgents.map((agent, index) => (
              <AgentCard key={index} agent={agent} onClick={handleAgentClick} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default DashboardContainer;