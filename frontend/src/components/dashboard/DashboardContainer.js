import { useState, useEffect } from 'react';
import './DashboardContainer.css';
import AgentCard from '../AgentCard';
import AgentDetails from '../AgentDetails';
import { agentService } from '../../services/agentService';

const Ellipse1 = () => <svg width="120" height="120" viewBox="0 0 120 120" fill="none"><circle cx="60" cy="60" r="60" fill="#E3F2FD"/></svg>;
const Ellipse2 = () => <svg width="120" height="120" viewBox="0 0 120 120" fill="none"><circle cx="60" cy="60" r="60" fill="#F3E5F5"/></svg>;
const Ellipse3 = () => <svg width="120" height="120" viewBox="0 0 120 120" fill="none"><circle cx="60" cy="60" r="60" fill="#E8F5E8"/></svg>;
const DropdownArrow = () => <svg width="12" height="8" viewBox="0 0 12 8" fill="none"><path d="M1 1L6 6L11 1" stroke="#666" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>;


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
        const avatars = [Ellipse1, Ellipse2, Ellipse3];
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
    : agents.filter(agent => 
        Array.isArray(agent.programs) 
          ? agent.programs.includes(selectedFilter)
          : agent.specialization === selectedFilter
      );

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
              <DropdownArrow className="dropdown-arrow" />
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